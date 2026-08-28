import { create } from 'zustand';
import {
  decodeAgentTerminalSnapshotV1,
  type AgentTerminalSnapshotV1,
  type TerminalCoordinatorErrorCodeV1,
} from '@/lib/agent-terminal-control';

export type AgentTerminalProjectionStatusV1 =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'failed';

export type AgentTerminalSnapshotInstallResultV1 =
  | 'installed'
  | 'stale'
  | 'invalid'
  | 'bindingMismatch';

export interface AgentTerminalProjectionErrorV1 {
  code: TerminalCoordinatorErrorCodeV1;
  message: string;
}

interface AgentTerminalProjectionStateV1 {
  snapshotsByRunId: Record<string, AgentTerminalSnapshotV1>;
  statusByRunId: Record<string, AgentTerminalProjectionStatusV1>;
  errorByRunId: Record<string, AgentTerminalProjectionErrorV1 | undefined>;
  snapshotReceivedAtByRunId: Record<string, number>;
  refreshHintByRunId: Record<string, string | undefined>;
  installSnapshot: (value: unknown) => AgentTerminalSnapshotInstallResultV1;
  markLoading: (runId: string) => void;
  markUnavailable: (runId: string, error: AgentTerminalProjectionErrorV1) => void;
  markFailed: (runId: string, error: AgentTerminalProjectionErrorV1) => void;
  noteRefreshHint: (runId: string, hint: string) => void;
  clearRun: (runId: string) => void;
  reset: () => void;
}

const initialState = {
  snapshotsByRunId: {},
  statusByRunId: {},
  errorByRunId: {},
  snapshotReceivedAtByRunId: {},
  refreshHintByRunId: {},
} satisfies Pick<
  AgentTerminalProjectionStateV1,
  | 'snapshotsByRunId'
  | 'statusByRunId'
  | 'errorByRunId'
  | 'snapshotReceivedAtByRunId'
  | 'refreshHintByRunId'
>;

function sameBinding(
  current: AgentTerminalSnapshotV1,
  incoming: AgentTerminalSnapshotV1,
): boolean {
  return current.runId === incoming.runId
    && current.targetDigest === incoming.targetDigest
    && current.sessionId === incoming.sessionId;
}

const TERMINAL_ACTION_STATES = new Set([
  'rejected',
  'expired',
  'revoked',
  'handoffRequired',
  'completed',
  'failed',
  'cancelled',
  'unknownEffect',
]);

function preservesTerminalActions(
  current: AgentTerminalSnapshotV1,
  incoming: AgentTerminalSnapshotV1,
): boolean {
  const incomingById = new Map(incoming.actions.map((action) => [action.actionId, action]));
  return current.actions.every((action) => {
    if (!TERMINAL_ACTION_STATES.has(action.state)) return true;
    return incomingById.get(action.actionId)?.state === action.state;
  });
}

/**
 * Backend-snapshot-only projection for a dedicated Agent PTY.
 *
 * No user input, takeover payload, approval secret, lease token, output chunk,
 * or xterm buffer is represented in this store. Transport/status events may
 * request a refresh, but only a decoded non-stale snapshot can alter authority.
 */
export const useAgentTerminalStore = create<AgentTerminalProjectionStateV1>()((set, get) => ({
  ...initialState,
  installSnapshot: (value) => {
    let snapshot: AgentTerminalSnapshotV1;
    try {
      snapshot = decodeAgentTerminalSnapshotV1(value);
    } catch {
      return 'invalid';
    }
    const current = get().snapshotsByRunId[snapshot.runId];
    if (current && !sameBinding(current, snapshot)) {
      return 'bindingMismatch';
    }
    if (current && snapshot.lastSequence < current.lastSequence) {
      return 'stale';
    }
    if (current && !preservesTerminalActions(current, snapshot)) {
      return 'invalid';
    }
    set((state) => ({
      snapshotsByRunId: {
        ...state.snapshotsByRunId,
        [snapshot.runId]: snapshot,
      },
      statusByRunId: {
        ...state.statusByRunId,
        [snapshot.runId]: 'ready',
      },
      errorByRunId: {
        ...state.errorByRunId,
        [snapshot.runId]: undefined,
      },
      snapshotReceivedAtByRunId: {
        ...state.snapshotReceivedAtByRunId,
        [snapshot.runId]: Date.now(),
      },
      refreshHintByRunId: {
        ...state.refreshHintByRunId,
        [snapshot.runId]: undefined,
      },
    }));
    return 'installed';
  },
  markLoading: (runId) => set((state) => ({
    statusByRunId: { ...state.statusByRunId, [runId]: 'loading' },
    errorByRunId: { ...state.errorByRunId, [runId]: undefined },
  })),
  markUnavailable: (runId, error) => set((state) => ({
    statusByRunId: { ...state.statusByRunId, [runId]: 'unavailable' },
    errorByRunId: { ...state.errorByRunId, [runId]: error },
    refreshHintByRunId: { ...state.refreshHintByRunId, [runId]: undefined },
  })),
  markFailed: (runId, error) => set((state) => ({
    statusByRunId: { ...state.statusByRunId, [runId]: 'failed' },
    errorByRunId: { ...state.errorByRunId, [runId]: error },
    refreshHintByRunId: { ...state.refreshHintByRunId, [runId]: undefined },
  })),
  noteRefreshHint: (runId, hint) => set((state) => ({
    refreshHintByRunId: { ...state.refreshHintByRunId, [runId]: hint },
  })),
  clearRun: (runId) => set((state) => {
    const snapshotsByRunId = { ...state.snapshotsByRunId };
    const statusByRunId = { ...state.statusByRunId };
    const errorByRunId = { ...state.errorByRunId };
    const snapshotReceivedAtByRunId = { ...state.snapshotReceivedAtByRunId };
    const refreshHintByRunId = { ...state.refreshHintByRunId };
    delete snapshotsByRunId[runId];
    delete statusByRunId[runId];
    delete errorByRunId[runId];
    delete snapshotReceivedAtByRunId[runId];
    delete refreshHintByRunId[runId];
    return {
      snapshotsByRunId,
      statusByRunId,
      errorByRunId,
      snapshotReceivedAtByRunId,
      refreshHintByRunId,
    };
  }),
  reset: () => set(initialState),
}));
