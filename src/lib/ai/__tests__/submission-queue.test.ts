import { describe, expect, it } from 'vitest';
import { AiSubmissionQueue } from '../submission-queue';
import { createAiComposerState, reduceAiComposer } from '../composer-machine';
import type { AiSubmitInput } from '../session-adapter';

describe('continuous admission', () => {
  it('keeps later work behind a rejected preparation and retries the original identity', async () => {
    const received: string[] = [];
    const input = (id: string): AiSubmitInput => ({ clientOperationId: id, content: id, mode: 'nextTurn',
      provider: { id: 'local', kind: 'openAiCompatible', profile: 'generic', baseUrl: '', model: 'local', requiresApiKey: false } });
    const queue = new AiSubmissionQueue('session', async (sessionId, value) => {
      received.push(value.clientOperationId);
      return { sessionId: sessionId!, clientOperationId: value.clientOperationId, mode: value.mode };
    });
    const rejected = queue.enqueue('A', async () => { throw new Error('preparation unavailable'); });
    const later = queue.enqueue('B', async () => input('B'));
    await expect(rejected).rejects.toThrow('preparation unavailable');
    expect(received).toEqual([]);
    await queue.enqueue('A', async () => input('A'));
    await later;
    expect(received).toEqual(['A', 'B']);
  });

  it('settles an admission racing stop before admitting the remaining paused work', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const queue = new AiSubmissionQueue('session', async (sessionId, input) => {
      order.push(`${input.clientOperationId}:${Boolean(input.paused)}`);
      if (input.clientOperationId === 'A') await gate;
      return { sessionId: sessionId!, clientOperationId: input.clientOperationId, mode: input.mode };
    }, async () => { order.push('stop'); });
    const input = (id: string): AiSubmitInput => ({ clientOperationId: id, content: id, mode: 'nextTurn',
      provider: { id: 'local', kind: 'openAiCompatible', profile: 'generic', baseUrl: '', model: 'local', requiresApiKey: false } });
    const a = queue.enqueue('A', async () => input('A'));
    const b = queue.enqueue('B', async () => input('B'));
    await expect.poll(() => order).toEqual(['A:false']);
    queue.pause();
    release();
    await Promise.all([a, b]);
    await queue.enqueue('C', async () => input('C'));
    expect(order).toEqual(['A:false', 'stop', 'B:true', 'C:false']);
  });

  it('accepts distinct drafts while the first creation has no receipt', () => {
    let state = createAiComposerState();
    for (const content of ['A', 'B', 'C']) {
      state = reduceAiComposer(state, { type: 'draft.changed', value: content }).state;
      const transition = reduceAiComposer(state, { type: 'submit.requested', gesture: 'keyboard',
        accelerated: false, clientOperationId: content, now: 1, hasProvider: true, canCreateSession: true });
      expect(transition.effects[0].type).toBe('submit');
      state = transition.state;
      expect(state.draft).toBe('');
    }
    expect(state.pendingSubmissions.map(item => item.mode)).toEqual(['start', 'nextTurn', 'nextTurn']);
    expect(state.pendingSubmissions.map(item => item.startsTurn)).toEqual([true, false, false]);
    state = reduceAiComposer(state, { type: 'submit.accepted', receipt: {
      clientOperationId: 'A', sessionId: 'created', mode: 'start',
    } }).state;
    expect(state.pendingSubmissions.map(item => item.sessionId)).toEqual(['created', 'created', 'created']);
  });

  it('keeps a durable admission successful when its trailing stop fails and drains later work', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const received: string[] = [];
    const paused: boolean[] = [];
    const failures: unknown[] = [];
    const stopError = new Error('Stop disconnected');
    const queue = new AiSubmissionQueue('session', async (sessionId, input) => {
      received.push(input.clientOperationId);
      paused.push(Boolean(input.paused));
      if (input.clientOperationId === 'A') await gate;
      return { sessionId: sessionId!, clientOperationId: input.clientOperationId, mode: input.mode };
    }, async () => { throw stopError; }, (sessionId, error) => {
      expect(sessionId).toBe('session');
      failures.push(error);
    });
    const input = (id: string): AiSubmitInput => ({ clientOperationId: id, content: id, mode: 'nextTurn',
      provider: { id: 'local', kind: 'openAiCompatible', profile: 'generic', baseUrl: '', model: 'local', requiresApiKey: false } });
    const first = queue.enqueue('A', async () => input('A'));
    const later = queue.enqueue('B', async () => input('B'));
    await expect.poll(() => received).toEqual(['A']);
    queue.pause();
    release();
    expect((await first).clientOperationId).toBe('A');
    expect((await later).clientOperationId).toBe('B');
    await queue.enqueue('C', async () => input('C'));
    expect(received).toEqual(['A', 'B', 'C']);
    expect(paused).toEqual([false, true, false]);
    expect(failures).toEqual([stopError]);
  });

  it('preserves a stop failure when a committed message is reconciled later', () => {
    let state = createAiComposerState({ sessionId: 'session', runtimeStatus: 'running', draft: 'A' });
    state = reduceAiComposer(state, { type: 'submit.requested', gesture: 'keyboard', accelerated: false,
      clientOperationId: 'A', now: 1, hasProvider: true, canCreateSession: true }).state;
    const error = { kind: 'offline' as const, message: 'Stop disconnected', retryable: true };
    state = reduceAiComposer(state, { type: 'error.reported', error }).state;
    state = reduceAiComposer(state, { type: 'submit.accepted', receipt: {
      sessionId: 'session', clientOperationId: 'A', mode: 'nextTurn',
    } }).state;
    state = reduceAiComposer(state, { type: 'submit.committed', clientOperationId: 'A' }).state;
    expect(state.pendingSubmissions).toEqual([]);
    expect(state.failedDrafts).toEqual([]);
    expect(state.lastError).toBe(error);
    expect(reduceAiComposer(state, { type: 'error.dismissed' }).state.lastError).toBeNull();
  });

  it('serializes actual asynchronous work and binds later work to the first receipt', async () => {
    const order: string[] = [];
    const owners: (string | null)[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queue = new AiSubmissionQueue(null, async (owner, input) => {
      order.push(input.clientOperationId);
      owners.push(owner);
      if (input.clientOperationId === 'A') await gate;
      return { sessionId: 'created', clientOperationId: input.clientOperationId, mode: input.mode };
    });
    const prepare = (id: string): AiSubmitInput => ({ clientOperationId: id, content: id, mode: 'nextTurn',
      provider: { id: 'local', kind: 'openAiCompatible', profile: 'generic', baseUrl: '', model: 'local', requiresApiKey: false } });
    const a = queue.enqueue('A', async () => prepare('A'));
    const b = queue.enqueue('B', async () => prepare('B'));
    const c = queue.enqueue('C', async () => prepare('C'));
    await expect.poll(() => order).toEqual(['A']);
    release();
    await Promise.all([a, b, c]);
    expect(order).toEqual(['A', 'B', 'C']);
    expect(owners).toEqual([null, 'created', 'created']);
  });
});
