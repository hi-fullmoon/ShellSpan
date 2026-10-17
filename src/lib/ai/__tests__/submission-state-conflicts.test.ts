import { expect, it } from 'vitest';
import { createAiComposerState, reduceAiComposer, type AiComposerState } from '../composer-machine';
import { AiAdmissionUnconfirmedError, normalizeAiSessionError } from '../session-error';

function send(state: AiComposerState, id: string): AiComposerState {
  return reduceAiComposer(state, { type: 'submit.requested', content: id,
    gesture: 'keyboard', accelerated: false, clientOperationId: id,
    now: 1, hasProvider: true, canCreateSession: true }).state;
}

it('distinguishes waiting admissions from the active send without inventing execution', () => {
  let state = send(send(createAiComposerState(), 'first'), 'second');
  expect(state.pendingSubmissions.map(item => item.state)).toEqual(['queued', 'queued']);
  state = reduceAiComposer(state, { type: 'submit.timedOut', clientOperationId: 'second',
    error: normalizeAiSessionError(new AiAdmissionUnconfirmedError()) }).state;
  expect(state.pendingSubmissions[1].state).toBe('queued');
  state = reduceAiComposer(state, { type: 'submit.started', clientOperationId: 'first' }).state;
  expect(state.pendingSubmissions.map(item => item.state)).toEqual(['sending', 'queued']);
  state = reduceAiComposer(state, { type: 'submit.accepted', receipt: {
    sessionId: 'conversation', clientOperationId: 'first', mode: 'start',
  } }).state;
  expect(state.runtimeStatus).toBe('idle');
  expect(state.pendingSubmissions.map(item => item.state)).toEqual(['accepted', 'queued']);
});

it('clears a late committed failure even after its pending entry has been removed', () => {
  const error = normalizeAiSessionError(new AiAdmissionUnconfirmedError());
  expect(error.deliveryUnknown).toBe(true);
  let state = send(createAiComposerState({ sessionId: 'conversation', draft: 'new draft' }), 'original');
  state = reduceAiComposer(state, { type: 'submit.failed', clientOperationId: 'original', error }).state;
  expect(state.pendingSubmissions).toEqual([]);
  expect(state.failedDrafts).toHaveLength(1);
  state = reduceAiComposer(state, { type: 'submit.committed', clientOperationId: 'original' }).state;
  expect(state.failedDrafts).toEqual([]);
  expect(state.lastError).toBeNull();
  expect(state.draft).toBe('new draft');
  expect(reduceAiComposer(state, { type: 'submit.failed', clientOperationId: 'original', error }).state).toBe(state);
});

it('retries only the original identity once while preserving later work and the editor', () => {
  let state = send(send(createAiComposerState({ draft: 'new draft' }), 'first'), 'second');
  state = reduceAiComposer(state, { type: 'submit.failed', clientOperationId: 'first',
    error: normalizeAiSessionError(new AiAdmissionUnconfirmedError()) }).state;
  const retry = { type: 'retry.requested' as const, failedDraftId: 'first', clientOperationId: 'unused-new-id',
    now: 2, hasProvider: true, canCreateSession: true };
  const transition = reduceAiComposer(state, retry);
  expect(transition.effects[0]).toMatchObject({ type: 'submit', payload: { clientOperationId: 'first', mode: 'start' } });
  expect(transition.state.pendingSubmissions.map(item => item.clientOperationId)).toEqual(['first', 'second']);
  expect(transition.state.pendingSubmissions.find(item => item.clientOperationId === 'first')?.startsTurn).toBe(true);
  expect(transition.state.failedDrafts).toEqual([]);
  expect(transition.state.lastError).toBeNull();
  expect(transition.state.draft).toBe('new draft');
  expect(reduceAiComposer(transition.state, retry).effects).toEqual([]);
});

it('keeps unrelated control errors while a late admission is reconciled', () => {
  const admissionError = normalizeAiSessionError(new AiAdmissionUnconfirmedError());
  const controlError = normalizeAiSessionError(new Error('Stop disconnected'));
  let state = send(createAiComposerState({ sessionId: 'conversation' }), 'first');
  state = reduceAiComposer(state, { type: 'submit.failed', clientOperationId: 'first', error: admissionError }).state;
  state = reduceAiComposer(state, { type: 'error.reported', error: controlError }).state;
  state = reduceAiComposer(state, { type: 'submit.committed', clientOperationId: 'first' }).state;
  expect(state.failedDrafts).toEqual([]);
  expect(state.lastError).toBe(controlError);
});

it('keeps FIFO order when an earlier receipt arrives between failure and retry, even at the same timestamp', () => {
  let state = createAiComposerState({ sessionId: 'conversation', runtimeStatus: 'running', draft: 'new draft' });
  for (const id of ['A', 'B', 'C']) state = send(state, id);
  state = reduceAiComposer(state, { type: 'submit.accepted', receipt: {
    sessionId: 'conversation', clientOperationId: 'A', mode: 'nextTurn',
  } }).state;
  state = reduceAiComposer(state, { type: 'submit.failed', clientOperationId: 'B',
    error: normalizeAiSessionError(new Error('Disconnected')) }).state;
  state = reduceAiComposer(state, { type: 'submit.committed', clientOperationId: 'A' }).state;
  state = send(state, 'D');
  const retry = { type: 'retry.requested' as const, failedDraftId: 'B', clientOperationId: 'unused',
    now: 10, hasProvider: true, canCreateSession: true };
  state = reduceAiComposer(state, retry).state;
  expect(state.pendingSubmissions.map(item => item.clientOperationId)).toEqual(['B', 'C', 'D']);
  expect(state.pendingSubmissions[0].createdAtUnixMs).toBe(1);
  expect(state.draft).toBe('new draft');
  state = reduceAiComposer(state, { type: 'submit.failed', clientOperationId: 'B',
    error: normalizeAiSessionError(new Error('Disconnected')) }).state;
  state = reduceAiComposer(state, retry).state;
  expect(state.pendingSubmissions.map(item => item.clientOperationId)).toEqual(['B', 'C', 'D']);
});
