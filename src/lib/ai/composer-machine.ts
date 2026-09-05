import type { AiSessionStatus } from './conversation-node';
import {
  resolveAiSubmission,
  type AiBusyPreference,
  type AiSubmissionRejection,
} from './submission-policy';
import type { AiSessionError, AiSubmissionMode, AiSubmitReceipt } from './session-adapter';

export type AiComposerPhase = 'idle' | 'running' | 'waitingApproval' | 'waitingQuestion' | 'submitting' | 'error';

export interface AiDetachedSubmission {
  readonly clientOperationId: string;
  readonly sessionId: string | null;
  readonly content: string;
  readonly mode: AiSubmissionMode;
  readonly createdAtUnixMs: number;
  readonly retryOf?: string;
}

export interface AiFailedDraft {
  readonly id: string;
  readonly content: string;
  readonly mode: AiSubmissionMode;
  readonly error: AiSessionError;
}

export type AiPendingSubmission = AiDetachedSubmission & {
  readonly state: 'sending' | 'accepted';
  readonly startsTurn?: boolean;
};

export interface AiComposerState {
  readonly phase: AiComposerPhase;
  readonly runtimeStatus: AiSessionStatus;
  readonly terminal: boolean;
  readonly sessionId: string | null;
  readonly draft: string;
  readonly detached: AiDetachedSubmission | null;
  readonly pendingSubmissions: readonly AiPendingSubmission[];
  readonly failedDrafts: readonly AiFailedDraft[];
  readonly preferredBusyMode: AiBusyPreference;
  readonly lastError: AiSessionError | null;
  readonly waitingApproval: boolean;
  readonly waitingQuestion?: boolean;
}

export type AiComposerEffect =
  | Readonly<{ type: 'submit'; payload: AiDetachedSubmission }>
  | Readonly<{ type: 'stop'; sessionId: string }>
  | Readonly<{ type: 'announce'; reason: AiSubmissionRejection | 'stopped' | 'submissionFailed' }>
  | Readonly<{ type: 'focusEditor' }>;

export type AiComposerEvent =
  | Readonly<{ type: 'draft.changed'; value: string }>
  | Readonly<{ type: 'preference.changed'; value: AiBusyPreference }>
  | Readonly<{
      type: 'runtime.synchronized';
      sessionId: string | null;
      status: AiSessionStatus;
      terminal: boolean;
      waitingApproval: boolean;
      waitingQuestion?: boolean;
    }>
  | Readonly<{
      type: 'submit.requested';
      gesture: 'keyboard' | 'primary';
      accelerated: boolean;
      clientOperationId: string;
      now: number;
      hasProvider: boolean;
      canCreateSession: boolean;
    }>
  | Readonly<{ type: 'submit.accepted'; receipt: AiSubmitReceipt }>
  | Readonly<{ type: 'submit.committed'; clientOperationId: string }>
  | Readonly<{ type: 'submit.failed'; clientOperationId: string; error: AiSessionError }>
  | Readonly<{ type: 'submit.timedOut'; clientOperationId: string; error: AiSessionError }>
  | Readonly<{
      type: 'retry.requested';
      failedDraftId: string;
      clientOperationId: string;
      now: number;
      hasProvider: boolean;
      canCreateSession: boolean;
    }>
  | Readonly<{ type: 'stop.requested' }>
  | Readonly<{ type: 'stop.succeeded' }>
  | Readonly<{ type: 'stop.failed'; error: AiSessionError }>
  | Readonly<{ type: 'error.reported'; error: AiSessionError }>
  | Readonly<{ type: 'error.dismissed' }>;

export interface AiComposerTransition {
  readonly state: AiComposerState;
  readonly effects: readonly AiComposerEffect[];
}

function runtimePhase(state: Pick<AiComposerState, 'runtimeStatus' | 'waitingApproval' | 'waitingQuestion'>): AiComposerPhase {
  if (state.waitingQuestion) return 'waitingQuestion';
  if (state.waitingApproval) return 'waitingApproval';
  return state.runtimeStatus === 'running' || state.runtimeStatus === 'waiting' ? 'running' : 'idle';
}

export function createAiComposerState(input?: Partial<AiComposerState>): AiComposerState {
  const base: AiComposerState = {
    phase: 'idle',
    runtimeStatus: 'idle',
    terminal: false,
    sessionId: null,
    draft: '',
    detached: null,
    pendingSubmissions: [],
    failedDrafts: [],
    preferredBusyMode: 'queue',
    lastError: null,
    waitingApproval: false,
  };
  const state = { ...base, ...input };
  return { ...state, phase: input?.phase ?? runtimePhase(state) };
}

function rejected(state: AiComposerState, reason: AiSubmissionRejection): AiComposerTransition {
  return { state, effects: reason === 'empty' ? [] : [{ type: 'announce', reason }] };
}

function beginSubmission(
  state: AiComposerState,
  payload: AiDetachedSubmission,
  draft: string,
  failedDrafts = state.failedDrafts,
): AiComposerTransition {
  return {
    state: {
      ...state,
      phase: 'submitting',
      draft,
      detached: payload,
      pendingSubmissions: [
        ...state.pendingSubmissions.filter((item) => item.clientOperationId !== payload.clientOperationId),
        {
          ...payload,
          state: 'sending',
          // Capture the gesture's intent before acceptance changes the runtime status.
          startsTurn: payload.mode !== 'nextStep'
            && state.runtimeStatus !== 'running' && state.runtimeStatus !== 'waiting',
        },
      ],
      failedDrafts,
      lastError: null,
    },
    effects: [{ type: 'submit', payload }, { type: 'focusEditor' }],
  };
}

function settleFailure(
  state: AiComposerState,
  clientOperationId: string,
  error: AiSessionError,
): AiComposerTransition {
  const pending = state.pendingSubmissions.find((item) => item.clientOperationId === clientOperationId);
  if (!pending) return { state, effects: [] };
  const restoresEditor = state.draft.length === 0;
  const failedDrafts = restoresEditor
    ? state.failedDrafts
    : [
        ...state.failedDrafts.filter((entry) => entry.id !== clientOperationId),
        { id: clientOperationId, content: pending.content, mode: pending.mode, error },
      ];
  return {
    state: {
      ...state,
      phase: state.detached !== null && state.detached.clientOperationId !== clientOperationId
        ? 'submitting'
        : 'error',
      draft: restoresEditor ? pending.content : state.draft,
      detached: null,
      pendingSubmissions: state.pendingSubmissions.filter((item) => item.clientOperationId !== clientOperationId),
      failedDrafts,
      lastError: error,
    },
    effects: [{ type: 'announce', reason: 'submissionFailed' }, { type: 'focusEditor' }],
  };
}

/** Pure per-session Composer reducer. Commands are returned as explicit effects. */
export function reduceAiComposer(
  state: AiComposerState,
  event: AiComposerEvent,
): AiComposerTransition {
  switch (event.type) {
    case 'draft.changed':
      return { state: { ...state, draft: event.value }, effects: [] };
    case 'preference.changed':
      return { state: { ...state, preferredBusyMode: event.value }, effects: [] };
    case 'runtime.synchronized': {
      const adoptsCreatedSession = state.sessionId === null
        && event.sessionId !== null
        && state.pendingSubmissions.some((item) => item.sessionId === null);
      const sessionChanged = state.sessionId !== event.sessionId && !adoptsCreatedSession;
      const next = {
        ...state,
        sessionId: event.sessionId,
        runtimeStatus: event.status,
        terminal: event.terminal,
        waitingApproval: event.waitingApproval,
        waitingQuestion: event.waitingQuestion ?? false,
        ...(adoptsCreatedSession ? {
          pendingSubmissions: state.pendingSubmissions.map((item) => (
            item.sessionId === null ? { ...item, sessionId: event.sessionId } : item
          )),
          detached: state.detached ? { ...state.detached, sessionId: event.sessionId } : null,
        } : {}),
        ...(sessionChanged ? {
          detached: null,
          pendingSubmissions: [],
          failedDrafts: [],
          lastError: null,
        } : {}),
      };
      return {
        state: {
          ...next,
          phase: state.phase === 'submitting' && !sessionChanged
            ? 'submitting'
            : state.phase === 'error' && !sessionChanged
              ? 'error'
              : runtimePhase(next),
        },
        effects: [],
      };
    }
    case 'submit.requested': {
      const decision = resolveAiSubmission({
        sessionStatus: state.runtimeStatus,
        terminal: state.terminal,
        sessionId: state.sessionId,
        waitingApproval: state.waitingApproval,
        waitingQuestion: state.waitingQuestion,
        hasProvider: event.hasProvider,
        canCreateSession: event.canCreateSession,
        draft: state.draft,
        gesture: event.gesture,
        accelerated: event.accelerated,
        preferredBusyMode: state.preferredBusyMode,
        submitting: state.detached !== null,
      });
      if (decision.kind === 'reject') return rejected(state, decision.reason);
      if (decision.kind === 'stop') {
        return state.sessionId === null
          ? rejected(state, 'sessionUnavailable')
          : { state, effects: [{ type: 'stop', sessionId: state.sessionId }] };
      }
      const payload: AiDetachedSubmission = {
        clientOperationId: event.clientOperationId,
        sessionId: state.sessionId,
        content: state.draft,
        mode: decision.mode,
        createdAtUnixMs: event.now,
      };
      return beginSubmission(state, payload, '');
    }
    case 'retry.requested': {
      if (state.detached !== null) return rejected(state, 'submitting');
      const failed = state.failedDrafts.find((entry) => entry.id === event.failedDraftId);
      if (!failed) return { state, effects: [] };
      const decision = resolveAiSubmission({
        sessionStatus: state.runtimeStatus,
        terminal: state.terminal,
        sessionId: state.sessionId,
        waitingApproval: state.waitingApproval,
        waitingQuestion: state.waitingQuestion,
        hasProvider: event.hasProvider,
        canCreateSession: event.canCreateSession,
        draft: failed.content,
        gesture: 'retry',
        accelerated: failed.mode === 'nextStep',
        preferredBusyMode: failed.mode === 'nextStep' ? 'queue' : state.preferredBusyMode,
        submitting: false,
      });
      if (decision.kind !== 'submit') {
        return rejected(state, decision.kind === 'reject' ? decision.reason : 'sessionUnavailable');
      }
      const payload: AiDetachedSubmission = {
        clientOperationId: event.clientOperationId,
        sessionId: state.sessionId,
        content: failed.content,
        mode: failed.mode,
        createdAtUnixMs: event.now,
        retryOf: failed.id,
      };
      return beginSubmission(
        state,
        payload,
        state.draft,
        state.failedDrafts.filter((entry) => entry.id !== failed.id),
      );
    }
    case 'submit.accepted':
      if (!state.pendingSubmissions.some((item) => (
        item.clientOperationId === event.receipt.clientOperationId
      ))) {
        return { state, effects: [] };
      }
      return {
        state: {
          ...state,
          phase: runtimePhase({
            runtimeStatus: state.runtimeStatus === 'idle' ? 'running' : state.runtimeStatus,
            waitingApproval: state.waitingApproval,
            waitingQuestion: state.waitingQuestion,
          }),
          runtimeStatus: state.runtimeStatus === 'idle' ? 'running' : state.runtimeStatus,
          sessionId: event.receipt.sessionId,
          detached: state.detached?.clientOperationId === event.receipt.clientOperationId
            ? null
            : state.detached,
          pendingSubmissions: state.pendingSubmissions.map((item) => (
            item.clientOperationId === event.receipt.clientOperationId
              ? { ...item, sessionId: event.receipt.sessionId, state: 'accepted' }
              : item
          )),
        },
        effects: [],
      };
    case 'submit.committed':
      if (!state.pendingSubmissions.some((item) => item.clientOperationId === event.clientOperationId)) {
        return { state, effects: [] };
      }
      const remainingFailedDrafts = state.failedDrafts.filter((item) => item.id !== event.clientOperationId);
      return {
        state: {
          ...state,
          pendingSubmissions: state.pendingSubmissions.filter((item) => (
            item.clientOperationId !== event.clientOperationId
          )),
          detached: state.detached?.clientOperationId === event.clientOperationId ? null : state.detached,
          failedDrafts: remainingFailedDrafts,
          phase: state.detached !== null && state.detached.clientOperationId !== event.clientOperationId
            ? 'submitting'
            : runtimePhase(state),
          lastError: remainingFailedDrafts.length === 0 ? null : state.lastError,
        },
        effects: [],
      };
    case 'submit.failed':
    case 'submit.timedOut':
      return settleFailure(state, event.clientOperationId, event.error);
    case 'stop.requested':
      return state.sessionId === null
        ? rejected(state, 'sessionUnavailable')
        : { state, effects: [{ type: 'stop', sessionId: state.sessionId }] };
    case 'stop.succeeded':
      return { state, effects: [{ type: 'announce', reason: 'stopped' }] };
    case 'stop.failed':
      return {
        state: { ...state, phase: 'error', lastError: event.error },
        effects: [{ type: 'announce', reason: 'submissionFailed' }],
      };
    case 'error.reported':
      return { state: { ...state, lastError: event.error }, effects: [] };
    case 'error.dismissed':
      return {
        state: { ...state, phase: state.phase === 'error' ? runtimePhase(state) : state.phase, lastError: null },
        effects: [],
      };
  }
}
