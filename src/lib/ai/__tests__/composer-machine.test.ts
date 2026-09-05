import { describe, expect, it } from 'vitest';

import {
  createAiComposerState,
  reduceAiComposer,
  type AiComposerEvent,
  type AiComposerState,
} from '@/lib/ai/composer-machine';

const retryableError = { kind: 'offline' as const, message: 'Disconnected', retryable: true };

function dispatch(state: AiComposerState, event: AiComposerEvent): ReturnType<typeof reduceAiComposer> {
  return reduceAiComposer(state, event);
}

function runningState(draft = 'Queue this'): AiComposerState {
  return createAiComposerState({
    phase: 'running',
    runtimeStatus: 'running',
    sessionId: 'session-1',
    draft,
  });
}

describe('reduceAiComposer', () => {
  it.each(['running', 'submitting', 'waitingApproval', 'waitingQuestion'] as const)(
    'reports and dismisses action errors without changing the %s phase', phase => {
      const state = createAiComposerState({ ...runningState(), phase });
      const reported = dispatch(state, { type: 'error.reported', error: retryableError });
      expect(reported.state).toEqual({ ...state, lastError: retryableError });
      expect(reported.effects).toEqual([]);
      expect(dispatch(reported.state, { type: 'error.dismissed' }).state).toEqual(state);
    },
  );
  it.each([
    ['idle', 'idle', false, 'idle'],
    ['running', 'running', false, 'running'],
    ['waiting runtime', 'waiting', false, 'running'],
    ['waiting approval', 'waiting', true, 'waitingApproval'],
    ['completed', 'completed', false, 'idle'],
  ] as const)('synchronizes %s phase', (_label, status, waitingApproval, phase) => {
    const result = dispatch(createAiComposerState(), {
      type: 'runtime.synchronized',
      sessionId: 'session-1',
      status,
      terminal: status === 'completed',
      waitingApproval,
    });
    expect(result.state).toEqual(expect.objectContaining({ phase, runtimeStatus: status }));
    expect(result.effects).toEqual([]);
  });

  it('detaches, clears, and emits one immutable Queue effect', () => {
    const result = dispatch(runningState('  Queue this  '), {
      type: 'submit.requested',
      gesture: 'keyboard',
      accelerated: false,
      clientOperationId: 'operation-1',
      now: 100,
      hasProvider: true,
      canCreateSession: true,
    });
    expect(result.state).toEqual(expect.objectContaining({
      phase: 'submitting',
      draft: '',
      detached: expect.objectContaining({ content: '  Queue this  ', mode: 'nextTurn' }),
    }));
    expect(result.effects).toEqual([
      { type: 'submit', payload: expect.objectContaining({ clientOperationId: 'operation-1', content: '  Queue this  ', mode: 'nextTurn' }) },
      { type: 'focusEditor' },
    ]);
  });

  it('prevents duplicate Enter and click while the detached payload is in flight', () => {
    const first = dispatch(runningState(), {
      type: 'submit.requested', gesture: 'keyboard', accelerated: false,
      clientOperationId: 'operation-1', now: 100, hasProvider: true, canCreateSession: true,
    });
    const duplicate = dispatch(first.state, {
      type: 'submit.requested', gesture: 'primary', accelerated: false,
      clientOperationId: 'operation-2', now: 101, hasProvider: true, canCreateSession: true,
    });
    expect(duplicate.state.pendingSubmissions[0]?.clientOperationId).toBe('operation-1');
    expect(duplicate.effects).toEqual([{ type: 'announce', reason: 'submitting' }]);
  });

  it('restores a failed detached draft only when the editor has no newer input', () => {
    const started = dispatch(runningState('original'), {
      type: 'submit.requested', gesture: 'keyboard', accelerated: false,
      clientOperationId: 'operation-1', now: 100, hasProvider: true, canCreateSession: true,
    }).state;
    const restored = dispatch(started, {
      type: 'submit.failed', clientOperationId: 'operation-1', error: retryableError,
    });
    expect(restored.state.draft).toBe('original');
    expect(restored.state.failedDrafts).toEqual([]);

    const withNewDraft = dispatch(started, { type: 'draft.changed', value: 'new input' }).state;
    const retained = dispatch(withNewDraft, {
      type: 'submit.failed', clientOperationId: 'operation-1', error: retryableError,
    });
    expect(retained.state.draft).toBe('new input');
    expect(retained.state.failedDrafts).toEqual([
      expect.objectContaining({ id: 'operation-1', content: 'original' }),
    ]);
  });

  it('accepts independently, keeps delivery pending, then commits by operation id', () => {
    const started = dispatch(runningState(), {
      type: 'submit.requested', gesture: 'keyboard', accelerated: true,
      clientOperationId: 'operation-1', now: 100, hasProvider: true, canCreateSession: true,
    }).state;
    const accepted = dispatch(started, {
      type: 'submit.accepted',
      receipt: { sessionId: 'session-1', clientOperationId: 'operation-1', mode: 'nextStep' },
    });
    expect(accepted.state).toEqual(expect.objectContaining({
      phase: 'running',
      detached: null,
      pendingSubmissions: [expect.objectContaining({ state: 'accepted', mode: 'nextStep' })],
    }));
    const committed = dispatch(accepted.state, {
      type: 'submit.committed', clientOperationId: 'operation-1',
    });
    expect(committed.state.pendingSubmissions).toEqual([]);
    expect(committed.state.phase).toBe('running');
  });

  it('adopts a newly created session view without discarding the in-flight detached payload', () => {
    const started = dispatch(createAiComposerState({ draft: 'first message' }), {
      type: 'submit.requested', gesture: 'keyboard', accelerated: false,
      clientOperationId: 'operation-1', now: 100, hasProvider: true, canCreateSession: true,
    }).state;
    const synchronized = dispatch(started, {
      type: 'runtime.synchronized', sessionId: 'created-session',
      status: 'running', waitingApproval: false,
      terminal: false,
    });
    expect(synchronized.state).toEqual(expect.objectContaining({
      phase: 'submitting',
      sessionId: 'created-session',
      detached: expect.objectContaining({ sessionId: 'created-session' }),
      pendingSubmissions: [expect.objectContaining({ sessionId: 'created-session' })],
    }));
  });

  it('keeps a newer editor draft while retrying a failed draft', () => {
    const state = createAiComposerState({
      phase: 'error', runtimeStatus: 'running',
      sessionId: 'session-1', draft: 'new input', lastError: retryableError,
      failedDrafts: [{ id: 'failed-1', content: 'retry me', mode: 'nextTurn', error: retryableError }],
    });
    const result = dispatch(state, {
      type: 'retry.requested', failedDraftId: 'failed-1', clientOperationId: 'retry-1',
      now: 200, hasProvider: true, canCreateSession: true,
    });
    expect(result.state.draft).toBe('new input');
    expect(result.state.failedDrafts).toEqual([]);
    expect(result.effects[0]).toEqual({
      type: 'submit',
      payload: expect.objectContaining({ content: 'retry me', retryOf: 'failed-1' }),
    });
  });

  it('settles multiple accepted running submissions independently', () => {
    const firstStarted = dispatch(runningState('first'), {
      type: 'submit.requested', gesture: 'keyboard', accelerated: false,
      clientOperationId: 'operation-1', now: 100, hasProvider: true, canCreateSession: true,
    }).state;
    const firstAccepted = dispatch(firstStarted, {
      type: 'submit.accepted',
      receipt: { sessionId: 'session-1', clientOperationId: 'operation-1', mode: 'nextTurn' },
    }).state;
    const withSecondDraft = dispatch(firstAccepted, { type: 'draft.changed', value: 'second' }).state;
    const secondStarted = dispatch(withSecondDraft, {
      type: 'submit.requested', gesture: 'keyboard', accelerated: true,
      clientOperationId: 'operation-2', now: 110, hasProvider: true, canCreateSession: true,
    }).state;
    expect(secondStarted.pendingSubmissions).toHaveLength(2);
    const firstFailed = dispatch(secondStarted, {
      type: 'submit.timedOut', clientOperationId: 'operation-1', error: retryableError,
    }).state;
    expect(firstFailed.phase).toBe('submitting');
    expect(firstFailed.pendingSubmissions.map((item) => item.clientOperationId)).toEqual(['operation-2']);
    expect(firstFailed.draft).toBe('first');
    const secondAccepted = dispatch(firstFailed, {
      type: 'submit.accepted',
      receipt: { sessionId: 'session-1', clientOperationId: 'operation-2', mode: 'nextStep' },
    }).state;
    expect(secondAccepted.pendingSubmissions).toEqual([
      expect.objectContaining({ clientOperationId: 'operation-2', state: 'accepted' }),
    ]);
  });

  it('isolates session switches and ignores stale settlement', () => {
    const started = dispatch(runningState(), {
      type: 'submit.requested', gesture: 'keyboard', accelerated: false,
      clientOperationId: 'operation-1', now: 100, hasProvider: true, canCreateSession: true,
    }).state;
    const switched = dispatch(started, {
      type: 'runtime.synchronized', sessionId: 'session-2',
      status: 'idle', waitingApproval: false,
      terminal: false,
    }).state;
    expect(switched.pendingSubmissions).toEqual([]);
    expect(switched.lastError).toBeNull();
    const stale = dispatch(switched, {
      type: 'submit.failed', clientOperationId: 'operation-1', error: retryableError,
    });
    expect(stale.state).toBe(switched);
    expect(stale.effects).toEqual([]);
  });

  it('has no mode-switching state in the product Composer contract', () => {
    const state = createAiComposerState();
    expect(state).not.toHaveProperty('preset');
    expect(state).not.toHaveProperty('presetLocked');
  });

  it('emits explicit Stop only for the addressed session', () => {
    expect(dispatch(runningState(''), { type: 'stop.requested' }).effects)
      .toEqual([{ type: 'stop', sessionId: 'session-1' }]);
    expect(dispatch(createAiComposerState(), { type: 'stop.requested' }).effects)
      .toEqual([{ type: 'announce', reason: 'sessionUnavailable' }]);
  });
});
