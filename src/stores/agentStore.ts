import { create } from 'zustand';
import { AgentEventCursorV1, type AgentEventCursorStatusV1 } from '@/lib/agent-events';
import {
  decodeAgentEventV1,
  decodeAgentRunSnapshotV1,
} from '@/lib/agent-protocol';
import { isAgentRunTerminalStateV1 } from '@/lib/agent-state';
import type {
  AgentCommandErrorV1,
  AgentEventTypeV1,
  AgentRunSnapshotV1,
} from '@/types/agent';

export interface AgentAcceptedMessageV1 {
  id: string;
  text: string;
  acceptedAt: number;
  kind: 'answer' | 'steering';
}

export interface AgentProjectionEventResultV1 {
  status: AgentEventCursorStatusV1 | 'invalid';
  runId?: string;
  resyncRequired: boolean;
}

interface AgentProjectionState {
  runsById: Record<string, AgentRunSnapshotV1>;
  activeRunId?: string;
  lastSequenceByRunId: Record<string, number>;
  resyncingRunIds: Record<string, boolean>;
  snapshotReceivedAtByRunId: Record<string, number>;
  acceptedMessagesByRunId: Record<string, AgentAcceptedMessageV1[]>;
  lastEventTypeByRunId: Record<string, AgentEventTypeV1 | undefined>;
  projectionErrorByRunId: Record<string, string | undefined>;
  startPending: boolean;
  startError?: AgentCommandErrorV1;
  attemptedGoal?: string;
  acceptEvent: (value: unknown) => AgentProjectionEventResultV1;
  installSnapshot: (value: unknown) => boolean;
  markResyncing: (runId: string, resyncing: boolean) => void;
  setStartPending: (pending: boolean, goal?: string) => void;
  setStartError: (error?: AgentCommandErrorV1, goal?: string) => void;
  recordAcceptedMessage: (
    runId: string,
    message: AgentAcceptedMessageV1,
  ) => void;
  dismissActiveRun: () => boolean;
  reset: () => void;
}

const cursorsByRunId = new Map<string, AgentEventCursorV1>();

const initialState = {
  runsById: {},
  lastSequenceByRunId: {},
  resyncingRunIds: {},
  snapshotReceivedAtByRunId: {},
  acceptedMessagesByRunId: {},
  lastEventTypeByRunId: {},
  projectionErrorByRunId: {},
  startPending: false,
} satisfies Pick<
  AgentProjectionState,
  | 'runsById'
  | 'lastSequenceByRunId'
  | 'resyncingRunIds'
  | 'snapshotReceivedAtByRunId'
  | 'acceptedMessagesByRunId'
  | 'lastEventTypeByRunId'
  | 'projectionErrorByRunId'
  | 'startPending'
>;

function sameFrozenBinding(
  current: AgentRunSnapshotV1,
  incoming: AgentRunSnapshotV1,
): boolean {
  return JSON.stringify(current.target) === JSON.stringify(incoming.target)
    && JSON.stringify(current.provider) === JSON.stringify(incoming.provider)
    && JSON.stringify(current.policy) === JSON.stringify(incoming.policy)
    && current.goal === incoming.goal;
}

function cursorFor(
  runId: string,
  snapshots: Record<string, AgentRunSnapshotV1>,
): AgentEventCursorV1 {
  const existing = cursorsByRunId.get(runId);
  if (existing) return existing;
  const cursor = new AgentEventCursorV1(runId);
  const snapshot = snapshots[runId];
  if (snapshot) cursor.installSnapshot(snapshot);
  cursorsByRunId.set(runId, cursor);
  return cursor;
}

/**
 * Snapshot-authoritative projection of backend Agent state.
 *
 * Live events are strictly decoded and sequence-checked, but never trusted to
 * invent view state from an unversioned payload. Any new contiguous event (or
 * a gap) requests a fresh backend snapshot. This keeps the P1-E UI compatible
 * with the current P1-A journal while failing closed until typed payload
 * contracts are wired by a later backend work package.
 */
export const useAgentStore = create<AgentProjectionState>()((set, get) => ({
  ...initialState,
  acceptEvent: (value) => {
    let event;
    try {
      event = decodeAgentEventV1(value);
    } catch {
      return { status: 'invalid', resyncRequired: false };
    }

    const cursor = cursorFor(event.runId, get().runsById);
    const update = cursor.accept(event);
    const needsSnapshot = update.status === 'applied'
      || update.status === 'gap'
      || update.resyncRequired;
    set((state) => ({
      lastSequenceByRunId: {
        ...state.lastSequenceByRunId,
        [event.runId]: update.lastSequence,
      },
      resyncingRunIds: {
        ...state.resyncingRunIds,
        [event.runId]: Boolean(state.resyncingRunIds[event.runId]) || needsSnapshot,
      },
      lastEventTypeByRunId: update.status === 'applied'
        ? { ...state.lastEventTypeByRunId, [event.runId]: event.type }
        : state.lastEventTypeByRunId,
    }));
    return {
      status: update.status,
      runId: event.runId,
      resyncRequired: needsSnapshot,
    };
  },
  installSnapshot: (value) => {
    let snapshot: AgentRunSnapshotV1;
    try {
      snapshot = decodeAgentRunSnapshotV1(value);
    } catch {
      return false;
    }

    const state = get();
    const current = state.runsById[snapshot.runId];
    if (current && !sameFrozenBinding(current, snapshot)) {
      set((previous) => ({
        projectionErrorByRunId: {
          ...previous.projectionErrorByRunId,
          [snapshot.runId]: 'The authoritative Agent snapshot changed a frozen run binding.',
        },
        resyncingRunIds: {
          ...previous.resyncingRunIds,
          [snapshot.runId]: false,
        },
      }));
      return false;
    }
    if (
      current
      && isAgentRunTerminalStateV1(current.state)
      && !isAgentRunTerminalStateV1(snapshot.state)
    ) {
      set((previous) => ({
        projectionErrorByRunId: {
          ...previous.projectionErrorByRunId,
          [snapshot.runId]: 'A non-terminal snapshot cannot replace an Agent terminal state.',
        },
        resyncingRunIds: {
          ...previous.resyncingRunIds,
          [snapshot.runId]: false,
        },
      }));
      return false;
    }
    const active = state.activeRunId ? state.runsById[state.activeRunId] : undefined;
    if (
      active
      && active.runId !== snapshot.runId
      && !isAgentRunTerminalStateV1(active.state)
    ) {
      set((previous) => ({
        projectionErrorByRunId: {
          ...previous.projectionErrorByRunId,
          [snapshot.runId]: 'A second active Agent run was rejected by the frontend projection.',
        },
      }));
      return false;
    }

    const cursor = cursorFor(snapshot.runId, state.runsById);
    const update = cursor.installSnapshot(snapshot);
    if (update.status === 'staleSnapshot' || update.status === 'ignoredRun') return false;
    const stillAheadOfSnapshot = update.lastSequence > snapshot.lastSequence;
    set((previous) => ({
      runsById: { ...previous.runsById, [snapshot.runId]: snapshot },
      activeRunId: snapshot.runId,
      lastSequenceByRunId: {
        ...previous.lastSequenceByRunId,
        [snapshot.runId]: update.lastSequence,
      },
      resyncingRunIds: {
        ...previous.resyncingRunIds,
        [snapshot.runId]: stillAheadOfSnapshot || update.resyncRequired,
      },
      snapshotReceivedAtByRunId: {
        ...previous.snapshotReceivedAtByRunId,
        [snapshot.runId]: Date.now(),
      },
      projectionErrorByRunId: {
        ...previous.projectionErrorByRunId,
        [snapshot.runId]: undefined,
      },
      startPending: false,
      startError: undefined,
      attemptedGoal: undefined,
    }));
    return true;
  },
  markResyncing: (runId, resyncing) => set((state) => ({
    resyncingRunIds: { ...state.resyncingRunIds, [runId]: resyncing },
  })),
  setStartPending: (pending, goal) => set({
    startPending: pending,
    ...(goal === undefined ? {} : { attemptedGoal: goal }),
    ...(pending ? { startError: undefined } : {}),
  }),
  setStartError: (error, goal) => set({
    startPending: false,
    startError: error,
    ...(goal === undefined ? {} : { attemptedGoal: goal }),
  }),
  recordAcceptedMessage: (runId, message) => set((state) => {
    const messages = state.acceptedMessagesByRunId[runId] ?? [];
    if (messages.some((item) => item.id === message.id)) return state;
    return {
      acceptedMessagesByRunId: {
        ...state.acceptedMessagesByRunId,
        [runId]: [...messages, message],
      },
    };
  }),
  dismissActiveRun: () => {
    const state = get();
    const run = state.activeRunId ? state.runsById[state.activeRunId] : undefined;
    if (run && !isAgentRunTerminalStateV1(run.state)) return false;
    set({
      activeRunId: undefined,
      startError: undefined,
      attemptedGoal: undefined,
      startPending: false,
    });
    return true;
  },
  reset: () => {
    cursorsByRunId.clear();
    set({
      ...initialState,
      activeRunId: undefined,
      startError: undefined,
      attemptedGoal: undefined,
    });
  },
}));
