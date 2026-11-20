import { useEffect } from 'react';
import { create } from 'zustand';
import { usePlatform } from '@/hooks/usePlatform';
import { invokeGetProfileSandbox, isLocalAgentSandboxPreview, isTauriRuntime } from '@/lib/ipc/tauri';
import { remoteGlibcMismatch } from '@/lib/terminal/terminal-surface-semantics';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import type { AgentExecutionSurface } from '@/types/agent-session';

interface SandboxCheck {
  readonly configured: boolean | null;
  readonly checking: boolean;
}

const useSandboxChecks = create<{ checks: Readonly<Partial<Record<string, SandboxCheck>>> }>()(() => ({ checks: {} }));
const localSandboxKey = 'local';
const profileSandboxKey = (profileId: string): string => `profile:${profileId}`;

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

export function useTerminalAgentExecution(terminal: TerminalSession | undefined) {
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
  const profileCheck = useSandboxChecks(state => profileId ? state.checks[profileSandboxKey(profileId)] : undefined);
  useEffect(() => {
    if (local) checkSandbox(localSandboxKey, isLocalAgentSandboxPreview);
    if (profileId) checkProfileSandbox(profileId);
  }, [local, profileId]);

  const localSandboxPreview = localCheck?.configured === true;
  const windowsSandbox = local && platform === 'windows' && sandboxEnabled;
  const localSandbox = localSandboxPreview || windowsSandbox;
  const profileSandbox = profileCheck?.configured === true;
  const sandboxChecking = (local && (!localCheck || localCheck.checking))
    || (Boolean(profileId) && (!profileCheck || profileCheck.checking));
  const glibcMismatch = remoteGlibcMismatch(terminal?.integrationReason);
  const creationSurface: AgentExecutionSurface = localSandbox || profileSandbox || glibcMismatch
    ? 'direct' : preference?.surface ?? defaultSurface;
  const reconnectingSurface = terminal?.reconnecting ? preference?.reconnectingSurface : undefined;
  return {
    creationSurface,
    executionSurface: conversation?.surface ?? reconnectingSurface ?? creationSurface,
    conversationId: conversation?.agentSessionId,
    localSandboxPreview,
    windowsSandbox,
    localSandbox,
    profileSandbox,
    profileSandboxResolved: typeof profileCheck?.configured === 'boolean' && !profileCheck.checking,
    sandboxChecking,
    sandboxEnabled,
    glibcMismatch,
  };
}
