import { describe, expect, it } from 'vitest';
import budgetFixture from '../../../tests/fixtures/agent-protocol/v1/budget-policy.json';
import {
  AGENT_BUDGET_DEFAULTS_V1,
  AGENT_BUDGET_HARD_LIMITS_V1,
  decodeAgentBudgetRequestV1,
  resolveAgentBudgetPolicyV1,
} from '@/lib/agent-budgets';

describe('Agent budget policy v1', () => {
  it('resolves every shared Rust/TypeScript budget fixture identically', () => {
    for (const fixture of budgetFixture.cases) {
      const resolve = () => resolveAgentBudgetPolicyV1(
        decodeAgentBudgetRequestV1(fixture.request),
      );
      if (!fixture.valid) {
        expect(resolve, fixture.name).toThrow();
        continue;
      }
      expect(resolve(), fixture.name).toEqual(fixture.expected);
    }
  });

  it('keeps defaults below immutable hard limits', () => {
    for (const field of Object.keys(AGENT_BUDGET_DEFAULTS_V1) as Array<keyof typeof AGENT_BUDGET_DEFAULTS_V1>) {
      expect(AGENT_BUDGET_DEFAULTS_V1[field]).toBeLessThanOrEqual(AGENT_BUDGET_HARD_LIMITS_V1[field]);
    }
    expect(AGENT_BUDGET_DEFAULTS_V1.maxConsecutiveInvalidDecisions).toBe(2);
    expect(AGENT_BUDGET_HARD_LIMITS_V1.maxConsecutiveInvalidDecisions).toBe(2);
  });

  it('rejects unknown, fractional, negative, and over-hard-limit requests', () => {
    expect(() => decodeAgentBudgetRequestV1({ maxModelTurns: 12, unlimited: true })).toThrow(/unknown field/);
    expect(() => decodeAgentBudgetRequestV1({ maxModelTurns: 1.5 })).toThrow(/integer/);
    expect(() => resolveAgentBudgetPolicyV1({ maxRunSeconds: -1 })).toThrow();
    expect(() => resolveAgentBudgetPolicyV1({ maxModelTurns: 21 })).toThrow();
  });
});
