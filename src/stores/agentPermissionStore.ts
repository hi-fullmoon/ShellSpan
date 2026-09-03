import { create } from 'zustand';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import {
  AGENT_PERMISSION_MODES,
  type AgentPermissionMode,
  type AgentApprovalTarget,
} from '@/types/agent-approval';

const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = 'autoApproveReadOnly';

export interface AgentPermissionBinding {
  readonly mode: AgentPermissionMode;
  readonly target: Readonly<AgentApprovalTarget>;
}

interface AgentPermissionState {
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
  bindings: {},
  getMode: (sessionId) => {
    const binding = get().bindings[sessionId];
    if (!binding || !sameTarget(binding.target, findLiveSession(sessionId))) {
      return DEFAULT_AGENT_PERMISSION_MODE;
    }
    return binding.mode;
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
      bindings: {
        ...state.bindings,
        [sessionId]: Object.freeze({ mode: mode as AgentPermissionMode, target }),
      },
    }));
    return true;
  },
  resetSession: (sessionId) => set((state) => {
    if (!(sessionId in state.bindings)) return state;
    const { [sessionId]: _removed, ...bindings } = state.bindings;
    return { bindings };
  }),
  resetAll: () => set({ bindings: {} }),
}));

// Permission grants are memory-only connection-instance capabilities. Any
// disconnect, close, removal, reconnect replacement, or in-place identity
// drift drops the grant; a later connected instance starts at the default.
useTerminalStore.subscribe((terminalState) => {
  const permissionState = useAgentPermissionStore.getState();
  for (const [sessionId, binding] of Object.entries(permissionState.bindings)) {
    const session = terminalState.sessions.find((item) => item.sessionId === sessionId);
    if (!sameTarget(binding.target, session)) permissionState.resetSession(sessionId);
  }
});
