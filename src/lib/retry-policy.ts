import contract from './retry-policy.json';

export interface AiRetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  maxServerDelayMs: number;
  jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<AiRetryPolicy> = Object.freeze(contract.defaults);
export const RETRY_LIMITS = Object.freeze({ maxAttempts: contract.maxAttempts, maxDelayMs: contract.maxDelayMs });

/** Validate persisted or transmitted settings without silently enabling extra attempts. */
export function parseRetryPolicy(value: unknown): AiRetryPolicy {
  if (value === undefined) return { ...DEFAULT_RETRY_POLICY };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid AI retry policy');
  const record = value as Record<string, unknown>;
  const fields = Object.keys(DEFAULT_RETRY_POLICY) as (keyof AiRetryPolicy)[];
  if (Object.keys(record).length !== fields.length || fields.some(key => typeof record[key] !== 'number' || !Number.isFinite(record[key]))) {
    throw new Error('Invalid AI retry policy');
  }
  const policy = record as unknown as AiRetryPolicy;
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > RETRY_LIMITS.maxAttempts
    || [policy.initialDelayMs, policy.maxDelayMs, policy.maxServerDelayMs].some(delay => !Number.isInteger(delay) || delay < 0 || delay > RETRY_LIMITS.maxDelayMs)
    || policy.initialDelayMs > policy.maxDelayMs || policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new Error('Invalid AI retry policy');
  }
  return Object.fromEntries(fields.map(key => [key, policy[key]])) as unknown as AiRetryPolicy;
}
