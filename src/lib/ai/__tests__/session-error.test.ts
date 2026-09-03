import { describe, expect, it } from 'vitest';

import { normalizeAiSessionError } from '@/lib/ai/session-error';

describe('normalizeAiSessionError', () => {
  it.each([
    ['API key is unauthorized', 'auth', true],
    ['HTTP 429 too many requests', 'rateLimit', true],
    ['Network disconnected', 'offline', true],
    ['Session is already busy', 'conflict', true],
    ['Request cancelled', 'cancelled', false],
    ['Terminal session ended', 'terminal', false],
    ['Unexpected adapter failure', 'unknown', true],
  ] as const)('normalizes %s', (message, kind, retryable) => {
    expect(normalizeAiSessionError(new Error(message))).toEqual({ kind, message, retryable });
  });

  it('preserves the current Runtime revision on a recognizable conflict', () => {
    expect(normalizeAiSessionError(
      new Error('Agent Runtime revision conflict: expected revision 7, current revision 9'),
    )).toMatchObject({ kind: 'conflict', retryable: true, currentRevision: 9 });
  });
});
