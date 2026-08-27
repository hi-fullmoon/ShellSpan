import type {
  AgentBudgetPolicyV1,
  AgentBudgetRequestV1,
  AgentBudgetSnapshotV1,
  AgentBudgetUsageV1,
} from '@/types/agent';

export const AGENT_BUDGET_DEFAULTS_V1: Readonly<AgentBudgetPolicyV1> = Object.freeze({
  maxRunSeconds: 10 * 60,
  maxModelTurns: 12,
  maxToolCalls: 10,
  toolTimeoutSeconds: 15,
  maxConsecutiveInvalidDecisions: 2,
  maxConsecutiveToolFailures: 2,
  maxPendingPlanItems: 6,
  maxSteeringQueueItems: 8,
  maxUserMessageBytes: 4 * 1024,
  stdoutCaptureBytes: 64 * 1024,
  stderrCaptureBytes: 16 * 1024,
  totalReadHardLimitBytes: 8 * 1024 * 1024,
});

export const AGENT_BUDGET_HARD_LIMITS_V1: Readonly<AgentBudgetPolicyV1> = Object.freeze({
  maxRunSeconds: 15 * 60,
  maxModelTurns: 20,
  maxToolCalls: 15,
  toolTimeoutSeconds: 60,
  maxConsecutiveInvalidDecisions: 2,
  maxConsecutiveToolFailures: 3,
  maxPendingPlanItems: 8,
  maxSteeringQueueItems: 16,
  maxUserMessageBytes: 8 * 1024,
  stdoutCaptureBytes: 256 * 1024,
  stderrCaptureBytes: 64 * 1024,
  totalReadHardLimitBytes: 16 * 1024 * 1024,
});

export type AgentBudgetFieldV1 = keyof AgentBudgetPolicyV1;

export class AgentBudgetPolicyError extends Error {
  readonly field: AgentBudgetFieldV1;

  constructor(field: AgentBudgetFieldV1, message = `Agent budget ${field} is outside the supported range`) {
    super(message);
    this.name = 'AgentBudgetPolicyError';
    this.field = field;
  }
}

const BUDGET_FIELDS = [
  'maxRunSeconds',
  'maxModelTurns',
  'maxToolCalls',
  'toolTimeoutSeconds',
  'maxConsecutiveInvalidDecisions',
  'maxConsecutiveToolFailures',
  'maxPendingPlanItems',
  'maxSteeringQueueItems',
  'maxUserMessageBytes',
  'stdoutCaptureBytes',
  'stderrCaptureBytes',
  'totalReadHardLimitBytes',
] as const satisfies readonly AgentBudgetFieldV1[];

const ZERO_ALLOWED_FIELDS = new Set<AgentBudgetFieldV1>([
  'maxToolCalls',
  'maxPendingPlanItems',
  'maxSteeringQueueItems',
  'stdoutCaptureBytes',
  'stderrCaptureBytes',
]);

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentBudgetPolicyError('maxRunSeconds', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>): void {
  const unknown = Object.keys(value).find((key) => !BUDGET_FIELDS.includes(key as AgentBudgetFieldV1));
  if (unknown) throw new AgentBudgetPolicyError('maxRunSeconds', `Agent budget contains unknown field ${unknown}`);
}

export function decodeAgentBudgetRequestV1(value: unknown): AgentBudgetRequestV1 {
  const request = objectValue(value, 'Agent budget request');
  exactKeys(request);
  const decoded: AgentBudgetRequestV1 = {};
  for (const field of BUDGET_FIELDS) {
    const candidate = request[field];
    if (candidate === undefined) continue;
    if (!Number.isSafeInteger(candidate)) {
      throw new AgentBudgetPolicyError(field, `Agent budget ${field} must be an integer`);
    }
    decoded[field] = candidate as number;
  }
  return decoded;
}

export function resolveAgentBudgetPolicyV1(
  request: AgentBudgetRequestV1 = {},
): AgentBudgetPolicyV1 {
  const policy = { ...AGENT_BUDGET_DEFAULTS_V1 };
  for (const field of BUDGET_FIELDS) {
    const requested = request[field];
    if (requested === undefined) continue;
    const minimum = ZERO_ALLOWED_FIELDS.has(field) ? 0 : 1;
    if (!Number.isSafeInteger(requested) || requested < minimum || requested > AGENT_BUDGET_HARD_LIMITS_V1[field]) {
      throw new AgentBudgetPolicyError(field);
    }
    policy[field] = requested;
  }
  return policy;
}

function exactObjectKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) throw new AgentBudgetPolicyError('maxRunSeconds', `${field} contains unknown field ${unknown}`);
}

function safeInteger(value: unknown, field: AgentBudgetFieldV1): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new AgentBudgetPolicyError(field, `${field} must be a non-negative integer`);
  }
  return value as number;
}

export function decodeAgentBudgetSnapshotV1(value: unknown): AgentBudgetSnapshotV1 {
  const snapshot = objectValue(value, 'Agent budget snapshot');
  exactObjectKeys(snapshot, ['schemaVersion', 'policy', 'usage'], 'Agent budget snapshot');
  if (snapshot.schemaVersion !== 1) {
    throw new AgentBudgetPolicyError('maxRunSeconds', 'Agent budget schemaVersion must be 1');
  }
  const policyValue = objectValue(snapshot.policy, 'Agent budget policy');
  exactObjectKeys(policyValue, BUDGET_FIELDS, 'Agent budget policy');
  const request = decodeAgentBudgetRequestV1(policyValue);
  if (BUDGET_FIELDS.some((field) => request[field] === undefined)) {
    throw new AgentBudgetPolicyError('maxRunSeconds', 'Agent budget policy is incomplete');
  }
  const policy = resolveAgentBudgetPolicyV1(request);

  const usageValue = objectValue(snapshot.usage, 'Agent budget usage');
  const usageKeys = [
    'elapsedMillis',
    'modelTurnsUsed',
    'toolCallsUsed',
    'consecutiveInvalidDecisions',
    'consecutiveToolFailures',
    'steeringQueueItems',
  ] as const;
  exactObjectKeys(usageValue, usageKeys, 'Agent budget usage');
  const usage: AgentBudgetUsageV1 = {
    elapsedMillis: safeInteger(usageValue.elapsedMillis, 'maxRunSeconds'),
    modelTurnsUsed: safeInteger(usageValue.modelTurnsUsed, 'maxModelTurns'),
    toolCallsUsed: safeInteger(usageValue.toolCallsUsed, 'maxToolCalls'),
    consecutiveInvalidDecisions: safeInteger(
      usageValue.consecutiveInvalidDecisions,
      'maxConsecutiveInvalidDecisions',
    ),
    consecutiveToolFailures: safeInteger(
      usageValue.consecutiveToolFailures,
      'maxConsecutiveToolFailures',
    ),
    steeringQueueItems: safeInteger(usageValue.steeringQueueItems, 'maxSteeringQueueItems'),
  };
  return { schemaVersion: 1, policy, usage };
}
