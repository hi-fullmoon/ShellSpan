import { expect, it } from 'vitest';
import { createAgentSessionAdapter } from '../agent-session-adapter';
import { AiSubmissionQueue } from '../submission-queue';
import type { AiSubmitInput } from '../session-adapter';
import { AiPreparationTimeoutError } from '../session-error';

it.concurrent.each(['resolve', 'reject'] as const)('times out preparation and ignores its late %s before retrying the same input', async lateResult => {
  const adapter = createAgentSessionAdapter();
  const submitted: { id: string; paused: boolean }[] = [];
  const starts: string[] = [];
  const queue = new AiSubmissionQueue(null, (sessionId, value) => {
    submitted.push({ id: value.clientOperationId, paused: Boolean(value.paused) });
    return adapter.submit(sessionId, value);
  });
  const input: AiSubmitInput<'agent'> = { clientOperationId: 'original', content: 'original', mode: 'start',
    provider: { id: 'local', kind: 'ollama', profile: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'local', requiresApiKey: false } };
  let release!: (value: AiSubmitInput<'agent'>) => void;
  let rejectPreparation!: (error: Error) => void;
  const preparation = new Promise<AiSubmitInput<'agent'>>((resolve, reject) => { release = resolve; rejectPreparation = reject; });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const first = queue.enqueue('original', () => preparation, () => starts.push('original'));
    const later = queue.enqueue('later', async () => { throw new Error('Later preparation unavailable'); }, () => starts.push('later'));
    const laterFailure = expect(later).rejects.toThrow('Later preparation unavailable');
    // Use the production 15-second timer and adapter validation, without clock or backend replacements.
    const outcome = await Promise.race([
      first.catch((error: unknown) => error),
      new Promise<Error>(resolve => { watchdog = setTimeout(() => resolve(new Error('Preparation did not time out')), 18_000); }),
    ]);
    expect(outcome).toBeInstanceOf(AiPreparationTimeoutError);
    expect(starts).toEqual(['original']);
    expect(submitted).toEqual([]);
    if (lateResult === 'resolve') { queue.pause(); release(input); }
    else rejectPreparation(new Error('Late preparation rejection'));
    await Promise.resolve();
    await Promise.resolve();
    expect(submitted).toEqual([]);
    const retry = queue.enqueue('original', async () => input, () => starts.push('retry'));
    await expect(retry).rejects.toThrow('requires create input');
    expect(submitted).toEqual([{ id: 'original', paused: lateResult === 'resolve' }]);
    expect(starts).toEqual(['original', 'retry']);
    queue.acknowledge({ sessionId: 'conversation', clientOperationId: 'original', mode: 'start', paused: true });
    await laterFailure;
    expect(starts).toEqual(['original', 'retry', 'later']);
  } finally {
    clearTimeout(watchdog);
    release(input);
    adapter.dispose();
  }
}, 25_000);

it('starts only the head and releases later preparation once an exact late receipt is reconciled', async () => {
  const adapter = createAgentSessionAdapter();
  const queue = new AiSubmissionQueue(null, adapter.submit);
  const starts: string[] = [];
  const input: AiSubmitInput<'agent'> = { clientOperationId: 'first', content: 'first', mode: 'start',
    provider: { id: 'local', kind: 'ollama', profile: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'local', requiresApiKey: false } };
  try {
    // Exercise the production adapter's local validation, with no IPC or model replacement.
    const first = queue.enqueue('first', async () => input, () => starts.push('first'));
    const second = queue.enqueue('second', async () => {
      throw new Error('Cannot prepare the later input');
    }, () => starts.push('second'));
    const laterFailure = expect(second).rejects.toThrow('Cannot prepare the later input');
    await expect(first).rejects.toThrow('requires create input');
    expect(starts).toEqual(['first']);
    queue.acknowledge({ sessionId: 'conversation', clientOperationId: 'unrelated', mode: 'start' });
    expect(starts).toEqual(['first']);
    queue.acknowledge({ sessionId: 'conversation', clientOperationId: 'first', mode: 'start' });
    await laterFailure;
    expect(starts).toEqual(['first', 'second']);
    queue.acknowledge({ sessionId: 'conversation', clientOperationId: 'first', mode: 'start' });
    expect(starts).toEqual(['first', 'second']);
  } finally {
    adapter.dispose();
  }
});
