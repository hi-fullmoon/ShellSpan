import { useEffect } from 'react';
import { create } from 'zustand';
import { usePlatform } from '@/hooks/usePlatform';
import {
  invokeGetProfileSandbox,
  invokeLocalSandboxStatus,
  isLocalAgentSandboxPreview,
  isTauriRuntime,
  type LocalSandboxStatus,
} from '@/lib/ipc/tauri';
import { remoteGlibcMismatch } from '@/lib/terminal/terminal-surface-semantics';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import type { AgentExecutionSurface, LocalSandboxKind } from '@/types/agent-session';

interface SandboxCheck {
  readonly configured: boolean | null;
  readonly checking: boolean;
}

interface LocalStatusState {
  readonly status: LocalSandboxStatus | null;
  readonly checking: boolean;
  readonly generation: number;
}

const useSandboxChecks = create<{ checks: Readonly<Partial<Record<string, SandboxCheck>>> }>()(() => ({ checks: {} }));
const useLocalSandboxStatusStore = create<LocalStatusState>()(() => ({ status: null, checking: false, generation: 0 }));
const localSandboxKey = 'local';
const profileSandboxKey = (profileId: string): string => `profile:${profileId}`;

function checkLocalSandboxStatus(): void {
  const current = useLocalSandboxStatusStore.getState();
  if (current.checking || current.status !== null) return;
  const generation = current.generation + 1;
  useLocalSandboxStatusStore.setState({ status: null, checking: true, generation });
  const finish = (status: LocalSandboxStatus): void => {
    if (useLocalSandboxStatusStore.getState().generation === generation) {
      useLocalSandboxStatusStore.setState({ status, checking: false, generation });
    }
  };
  void invokeLocalSandboxStatus().then(
    finish,
    () => finish({ supported: false }),
  );
}

function isLocal(terminal: TerminalSession | undefined): boolean {
  return terminal?.host === 'local' && terminal.port === 0;
}

function checkSandbox(key: string, read: () => Promise<boolean>, refresh = false): void {
  const previous = useSandboxChecks.getState().checks[key];
  if (previous && !refresh && (previous.checking || previous.configured !== null)) return;
  const pending = { configured: previous?.configured ?? null, checking: true };
  const publish = (result: SandboxCheck): void => {
    useSandboxChecks.setState(({ checks }) => ({ checks: { ...checks, [key]: result } }));
  };
  const complete = (configured: boolean | null): void => {
    if (useSandboxChecks.getState().checks[key] === pending) publish({ configured, checking: false });
  };
  publish(pending);
  void read().then(complete, () => complete(null));
}

function checkProfileSandbox(profileId: string, refresh = false): void {
  checkSandbox(profileSandboxKey(profileId), async () => Boolean((await invokeGetProfileSandbox(profileId)).policy), refresh);
}

// A profile check is shared by its panes and by the composer for as long as
// the workspace has a terminal using that profile.
const unsubscribeTerminals = useTerminalStore.subscribe(({ sessions }, previous) => {
  if (sessions === previous.sessions) return;
  const hasLocal = sessions.some(isLocal);
  const localState = useLocalSandboxStatusStore.getState();
  if (!hasLocal && (localState.status !== null || localState.checking)) {
    useLocalSandboxStatusStore.setState({
      status: null,
      checking: false,
      generation: localState.generation + 1,
    });
  }
  const entries = Object.entries(useSandboxChecks.getState().checks);
  if (entries.length === 0) return;
  const liveKeys = new Set(sessions.flatMap(session => [
    ...(isLocal(session) ? [localSandboxKey] : []),
    ...(session.profileId ? [profileSandboxKey(session.profileId)] : []),
  ]));
  if (entries.some(([key]) => !liveKeys.has(key))) {
    useSandboxChecks.setState({ checks: Object.fromEntries(entries.filter(([key]) => liveKeys.has(key))) });
  }
});

function refreshProfileSandbox(event: Event): void {
  const profileId: unknown = (event as CustomEvent).detail;
  if (typeof profileId === 'string' && useSandboxChecks.getState().checks[profileSandboxKey(profileId)]) {
    checkProfileSandbox(profileId, true);
  }
}

if (typeof window !== 'undefined') window.addEventListener('shellspan:connection-sandbox-changed', refreshProfileSandbox);
import.meta.hot?.dispose(() => {
  unsubscribeTerminals();
  window.removeEventListener('shellspan:connection-sandbox-changed', refreshProfileSandbox);
});

export function useTerminalAgentExecution(
  terminal: TerminalSession | undefined,
  options?: { readonly localSandboxOptOut?: boolean },
) {
  const terminalId = terminal?.sessionId ?? '';
  const preference = useAgentPermissionStore(state => state.preferences[terminalId]);
  const conversation = useAgentPermissionStore(state => state.conversationSurfaces[terminalId]);
  const defaultSurface = useAiSettingsStore(state => state.agentExecutionSurface);
  const sandboxEnabled = useAiSettingsStore(state => state.agentSandboxEnabled);
  const platform = usePlatform();
  const native = isTauriRuntime();
  const local = native && isLocal(terminal);
  const profileId = native ? terminal?.profileId : undefined;
  const localCheck = useSandboxChecks(state => local ? state.checks[localSandboxKey] : undefined);
  const localStatusState = useLocalSandboxStatusStore();
  const profileCheck = useSandboxChecks(state => profileId ? state.checks[profileSandboxKey(profileId)] : undefined);
  useEffect(() => {
    if (local) {
      checkSandbox(localSandboxKey, isLocalAgentSandboxPreview);
      if (platform === 'macos') checkLocalSandboxStatus();
    }
    if (profileId) checkProfileSandbox(profileId);
  }, [local, platform, profileId]);

  const localSandboxPreview = localCheck?.configured === true;
  const localSandboxOptOut = !localSandboxPreview && options?.localSandboxOptOut === true;
  const windowsSandboxSupported = local && platform === 'windows' && sandboxEnabled;
  const macSandboxSupported = local && platform === 'macos' && sandboxEnabled
    && localStatusState.status?.supported === true && localStatusState.status.kind === 'macNono';
  const canToggleLocalSandbox = !localSandboxPreview && (windowsSandboxSupported || macSandboxSupported);
  const windowsSandbox = windowsSandboxSupported && !localSandboxOptOut;
  const macSandbox = macSandboxSupported && !localSandboxOptOut;
  const localSandboxKind: LocalSandboxKind | undefined = windowsSandbox
    ? 'windowsAppContainer' : macSandbox ? 'macNono' : undefined;
  const localSandbox = localSandboxPreview || Boolean(localSandboxKind);
  const localSandboxSupportsVisiblePty = macSandbox
    && !localSandboxPreview
    && localStatusState.status?.supportsVisiblePty === true;
  const profileSandbox = profileCheck?.configured === true;
  const macStatusChecking = local && platform === 'macos' && sandboxEnabled
    && (localStatusState.checking || localStatusState.status === null);
  const sandboxChecking = (local && (!localCheck || localCheck.checking))
    || macStatusChecking
    || (Boolean(profileId) && (!profileCheck || profileCheck.checking));
  const glibcMismatch = remoteGlibcMismatch(terminal?.integrationReason);
  const localDirectOnly = localSandbox && !localSandboxSupportsVisiblePty;
  const creationSurface: AgentExecutionSurface = localDirectOnly || profileSandbox || glibcMismatch
    ? 'direct'
    : localSandboxSupportsVisiblePty && !preference?.surfaceExplicit
      ? 'boundTerminal'
      : preference?.surface ?? defaultSurface;
  const reconnectingSurface = terminal?.reconnecting ? preference?.reconnectingSurface : undefined;
  return {
    creationSurface,
    executionSurface: conversation?.surface ?? reconnectingSurface ?? creationSurface,
    conversationId: conversation?.agentSessionId,
    localSandboxPreview,
    canToggleLocalSandbox,
    windowsSandbox,
    localSandboxKind,
    localSandbox,
    localSandboxSupportsVisiblePty,
    profileSandbox,
    profileSandboxResolved: typeof profileCheck?.configured === 'boolean' && !profileCheck.checking,
    sandboxChecking,
    sandboxEnabled,
    glibcMismatch,
  };
}
