import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_POLICY, parseRetryPolicy } from '../retry-policy';

describe('Provider retry policy validation', () => {
  it('keeps legacy defaults and returns a separate snapshot', () => {
    expect(parseRetryPolicy(undefined)).toEqual({ maxAttempts: 3, initialDelayMs: 250, maxDelayMs: 4000, maxServerDelayMs: 30000, jitterRatio: 0.2 });
    const snapshot = parseRetryPolicy(DEFAULT_RETRY_POLICY);
    snapshot.maxAttempts = 1;
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(3);
    expect(parseRetryPolicy(snapshot).maxAttempts).toBe(1);
  });
  it.each([
    { maxAttempts: 0 }, { maxAttempts: 9 }, { maxAttempts: 1.5 },
    { initialDelayMs: -1 }, { initialDelayMs: 4001 }, { initialDelayMs: 0.5 },
    { maxDelayMs: 300001 }, { maxServerDelayMs: Infinity }, { maxServerDelayMs: 1e100 },
    { jitterRatio: NaN }, { jitterRatio: -0.1 }, { jitterRatio: 1.1 }, { unexpected: 1 },
  ])('rejects invalid values %j', changes => {
    expect(() => parseRetryPolicy({ ...DEFAULT_RETRY_POLICY, ...changes })).toThrow('Invalid AI retry policy');
  });
  it.each([null, [], {}, '3', { maxAttempts: 1 }])('rejects malformed persisted policies %j', value => {
    expect(() => parseRetryPolicy(value)).toThrow();
  });
});
