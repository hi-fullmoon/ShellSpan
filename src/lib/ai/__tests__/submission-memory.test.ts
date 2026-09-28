import { expect, it } from 'vitest';
import { createAiComposerState, reduceAiComposer } from '../composer-machine';
import { submissionMemoryFor } from '../submission-memory';

it('restores the failed head and later messages after a view closes, with the original IDs', () => {
  const owner = {};
  const memory = submissionMemoryFor(owner);
  const context = { key: 'terminal:memory-test' };
  let state = createAiComposerState({ sessionId: 'session', runtimeStatus: 'running' });
  for (const content of ['A', 'B', 'C']) {
    state = reduceAiComposer(state, { type: 'submit.requested', content, gesture: 'keyboard',
      accelerated: false, clientOperationId: content, now: 1, hasProvider: true, canCreateSession: true }).state;
  }
  memory.remember(context, state);
  memory.close(context);
  // The worker settles after the original view has been released.
  state = reduceAiComposer(memory.ledger.get(context)!, { type: 'submit.failed', clientOperationId: 'A',
    error: { kind: 'offline', message: 'Transport disconnected', retryable: true } }).state;
  memory.remember(context, state);
  const reopened = submissionMemoryFor(owner).reopen(context.key)!;
  expect(reopened.context).toBe(context);
  expect(reopened.state.failedDrafts.map(item => item.id)).toEqual(['A']);
  expect(reopened.state.pendingSubmissions.map(item => item.clientOperationId)).toEqual(['B', 'C']);
  expect(submissionMemoryFor({}).reopen(context.key)).toBeUndefined();
});

it('delivers late receipts to the new view without retaining the old listener', () => {
  const memory = submissionMemoryFor({});
  const context = { key: 'terminal:late-receipt' };
  let oldNotifications = 0;
  const release = memory.subscribe(() => { oldNotifications++; });
  const initial = createAiComposerState({ draft: 'A' });
  const started = reduceAiComposer(initial, { type: 'submit.requested', gesture: 'primary', accelerated: false,
    clientOperationId: 'A', now: 1, hasProvider: true, canCreateSession: true }).state;
  memory.remember(context, started);
  memory.close(context);
  release();
  const receipts: string[] = [];
  const closeNewView = memory.subscribe((_, state) => { if (state.sessionId) receipts.push(state.sessionId); });
  memory.remember(context, reduceAiComposer(started, { type: 'submit.accepted', receipt: {
    sessionId: 'created-session', clientOperationId: 'A', mode: 'start',
  } }).state);
  expect(oldNotifications).toBe(1);
  expect(receipts).toEqual(['created-session']);
  expect(memory.reopen(context.key)?.state.sessionId).toBe('created-session');
  closeNewView();
});

it('uses the new view settlement when a previous view worker finishes later', () => {
  const memory = submissionMemoryFor({});
  const oldContext = { key: 'terminal:revisited' };
  const newContext = { key: 'terminal:revisited' };
  let state = createAiComposerState({ sessionId: 'session', runtimeStatus: 'running' });
  for (const content of ['A', 'B']) state = reduceAiComposer(state, { type: 'submit.requested', content,
    gesture: 'keyboard', accelerated: false, clientOperationId: content, now: 1, hasProvider: true, canCreateSession: true }).state;
  memory.remember(oldContext, state);
  memory.remember(newContext, reduceAiComposer(state, { type: 'submit.committed', clientOperationId: 'A' }).state);
  const late = reduceAiComposer(memory.stateFor(oldContext)!, { type: 'submit.accepted', receipt: {
    sessionId: 'session', clientOperationId: 'B', mode: 'nextTurn',
  } }).state;
  memory.remember(oldContext, late);
  expect(memory.stateFor(newContext)?.pendingSubmissions.map(item => item.clientOperationId)).toEqual(['B']);
});
