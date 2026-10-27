import { describe, expect, it } from 'vitest';
import { requestErrorMessageKey } from '@/lib/ai/request-error';

describe('requestErrorMessageKey', () => {
  it.each([
    ['runtimeFailure: INVALID_MODEL_TOKEN_BUDGET: output consumes input space', 'ai.error.modelInputBudgetInvalid'],
    ['providerFailure: status=404 code=HTTP_404 message={"code":"model_not_found"}', 'ai.error.modelUnavailable'],
    ['runtimeFailure: semantic summary unavailable (inputBudget); preserved current Surface', 'ai.error.summaryUnavailable'],
    ['contextBudgetExceeded: semantic summary unavailable (inputBudget)', 'ai.error.contextBudgetExceeded'],
    ['runtimeFailure: compaction remained above its target after bounded degradation', 'ai.error.contextBudgetExceeded'],
    ['HTTP 404', 'ai.error.notFound'],
    ['HTTP 401', 'ai.error.authentication'],
    ['HTTP 429', 'ai.error.rateLimited'],
    ['connection refused', 'ai.error.connection'],
    ['request timed out', 'ai.error.timeout'],
    ['unexpected runtime failure', 'ai.error.generic'],
  ] as const)('provides a readable summary for %s', (message, key) => {
    expect(requestErrorMessageKey(message)).toBe(key);
  });
});
