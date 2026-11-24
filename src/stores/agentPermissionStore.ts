import { create } from 'zustand';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { remoteGlibcMismatch } from '@/lib/terminal/terminal-surface-semantics';
import type { AgentExecutionSurface } from '@/types/agent-session';
import {
  AGENT_PERMISSION_MODES,
  type AgentPermissionMode,
  type AgentApprovalTarget,
} from '@/types/agent-approval';

export interface AgentPermissionBinding {
  readonly mode: AgentPermissionMode;
  readonly target: Readonly<AgentApprovalTarget>;
}

interface TerminalConversationSurface {
  readonly agentSessionId: string;
  readonly surface: AgentExecutionSurface;
}

interface TerminalAgentPreference {
  mode: AgentPermissionMode;
  surface: AgentExecutionSurface;
  surfaceExplicit?: boolean;
  reconnectingSurface?: AgentExecutionSurface;
}

interface AgentPermissionState {
  readonly preferences: Readonly<Partial<Record<string, TerminalAgentPreference>>>;
  getExecutionSurface: (sessionId: string) => AgentExecutionSurface;
  setExecutionSurface: (sessionId: string, surface: AgentExecutionSurface) => void;
  readonly conversationSurfaces: Readonly<Partial<Record<string, TerminalConversationSurface>>>;
  setConversationSurface: (sessionId: string, selection?: TerminalConversationSurface) => void;
  readonly bindings: Readonly<Record<string, AgentPermissionBinding>>;
  getMode: (sessionId: string) => AgentPermissionMode;
  getBinding: (sessionId: string) => AgentPermissionBinding | undefined;
  setMode: (sessionId: string, mode: AgentPermissionMode | unknown) => boolean;
  resetSession: (sessionId: string) => void;
  resetAll: () => void;
}

function targetFromSession(session: TerminalSession): Readonly<AgentApprovalTarget> {
  return Object.freeze({
    kind: session.host === 'local' && session.port === 0 ? 'local' : 'remote',
    sessionId: session.sessionId,
    ...(session.profileId ? { profileId: session.profileId } : {}),
    host: session.host,
    port: session.port,
    username: session.username,
  });
}

function sameTarget(
  target: AgentApprovalTarget,
  session: TerminalSession | undefined,
): boolean {
  if (!session || session.status !== 'connected') return false;
  const live = targetFromSession(session);
  return live.kind === target.kind
    && live.sessionId === target.sessionId
    && live.profileId === target.profileId
    && live.host === target.host
    && live.port === target.port
    && live.username === target.username;
}

function findLiveSession(sessionId: string): TerminalSession | undefined {
  return useTerminalStore.getState().sessions.find(
    (session) => session.sessionId === sessionId,
  );
}

export const useAgentPermissionStore = create<AgentPermissionState>()((set, get) => ({
  preferences: {},
  getExecutionSurface: (sessionId) => get().preferences[sessionId]?.surface
    ?? useAiSettingsStore.getState().agentExecutionSurface,
  setExecutionSurface: (sessionId, surface) => {
    const preference = get().preferences[sessionId];
    if (!preference && !findLiveSession(sessionId)) return;
    const base = preference ?? {
      mode: useAiSettingsStore.getState().agentPermissionMode,
      surface,
    };
    set((state) => ({
      preferences: {
        ...state.preferences,
        [sessionId]: { ...base, surface, surfaceExplicit: true },
      },
    }));
    useAiSettingsStore.getState().setAgentExecutionSurface(surface);
  },
  conversationSurfaces: {},
  setConversationSurface: (sessionId, selection) => {
    if (!findLiveSession(sessionId)) return;
    set((state) => {
      const previous = state.conversationSurfaces[sessionId];
      if (previous?.agentSessionId === selection?.agentSessionId && previous?.surface === selection?.surface) return state;
      const conversationSurfaces = { ...state.conversationSurfaces };
      if (selection) conversationSurfaces[sessionId] = selection;
      else delete conversationSurfaces[sessionId];
      return { conversationSurfaces };
    });
  },
  bindings: {},
  getMode: (sessionId) => {
    if (findLiveSession(sessionId)?.status !== 'connected') return 'autoApproveReadOnly';
    const binding = get().bindings[sessionId];
    return binding?.mode === 'fullAccess' && sameTarget(binding.target, findLiveSession(sessionId))
      ? 'fullAccess'
      : get().preferences[sessionId]?.mode ?? useAiSettingsStore.getState().agentPermissionMode;
  },
  getBinding: (sessionId) => {
    const binding = get().bindings[sessionId];
    return binding && sameTarget(binding.target, findLiveSession(sessionId))
      ? binding
      : undefined;
  },
  setMode: (sessionId, mode) => {
    const session = findLiveSession(sessionId);
    if (
      !session
      || session.status !== 'connected'
      || !AGENT_PERMISSION_MODES.some((candidate) => candidate === mode)
    ) {
      set((state) => {
        if (!(sessionId in state.bindings)) return state;
        const { [sessionId]: _removed, ...bindings } = state.bindings;
        return { bindings };
      });
      return false;
    }
    const target = targetFromSession(session);
    set((state) => ({
      preferences: {
        ...state.preferences,
        [sessionId]: { ...state.preferences[sessionId], mode: mode as AgentPermissionMode, surface: get().getExecutionSurface(sessionId) },
      },
      bindings: {
        ...state.bindings,
        [sessionId]: Object.freeze({ mode: mode as AgentPermissionMode, target }),
      },
    }));
    useAiSettingsStore.getState().setAgentPermissionMode(mode as AgentPermissionMode);
    return true;
  },
  resetSession: (sessionId) => set((state) => {
    if (!(sessionId in state.bindings)) return state;
    const { [sessionId]: _removed, ...bindings } = state.bindings;
    return { bindings };
  }),
  resetAll: () => set({ bindings: {} }),
}));

// Target bindings remain connection-scoped. New connected instances use the
// remembered preference rather than reusing a previous target binding.
useTerminalStore.subscribe((terminalState, previous) => {
  if (terminalState.sessions === previous.sessions) return;
  const permissionState = useAgentPermissionStore.getState();
  const defaults = useAiSettingsStore.getState();
  const preferences = Object.fromEntries(terminalState.sessions.map((session): [string, TerminalAgentPreference] => {
    const current = permissionState.preferences[session.sessionId];
    if (current) return [session.sessionId, current];
    const predecessorId = session.replacesSessionId;
    const predecessor = predecessorId ? previous.sessions.find(item => item.sessionId === predecessorId) : undefined;
    const previousPreference = predecessor ? permissionState.preferences[predecessor.sessionId] : undefined;
    // Keep the last mode during reconnect. The replacement still needs its own
    // validated conversation binding and capability state once connected.
    const reconnectingSurface = session.reconnecting && predecessor
      ? permissionState.conversationSurfaces[predecessor.sessionId]?.surface
        ?? (remoteGlibcMismatch(predecessor.integrationReason) ? 'direct' : previousPreference?.reconnectingSurface)
      : undefined;
    return [session.sessionId, {
      mode: defaults.agentPermissionMode,
      surface: previousPreference?.surface ?? defaults.agentExecutionSurface,
      ...(previousPreference?.surfaceExplicit ? { surfaceExplicit: true } : {}),
      reconnectingSurface,
    }];
  }));
  const conversationSurfaces = Object.fromEntries(Object.entries(permissionState.conversationSurfaces)
    .filter(([sessionId]) => Object.prototype.hasOwnProperty.call(preferences, sessionId)));
  useAgentPermissionStore.setState({ preferences, conversationSurfaces });
  for (const [sessionId, binding] of Object.entries(permissionState.bindings)) {
    const session = terminalState.sessions.find((item) => item.sessionId === sessionId);
    if (!sameTarget(binding.target, session)) permissionState.resetSession(sessionId);
  }
});
