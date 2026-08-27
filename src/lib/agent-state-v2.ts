import type {
  AgentApprovalStateV2,
  AgentRunStateV2,
  AgentToolCallStateV2,
  AgentVerificationStateV2,
} from '@/types/agent-v2';

export const AGENT_RUN_STATES_V2 = [
  'created',
  'collectingContext',
  'thinking',
  'validatingTool',
  'evaluatingRisk',
  'awaitingApproval',
  'executingTool',
  'executingChange',
  'verifyingChange',
  'observing',
  'awaitingUser',
  'pausing',
  'paused',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'blocked',
] as const satisfies readonly AgentRunStateV2[];

export const AGENT_RUN_TERMINAL_STATES_V2 = [
  'completed', 'failed', 'cancelled', 'blocked',
] as const satisfies readonly AgentRunStateV2[];

export const AGENT_TOOL_CALL_STATES_V2 = [
  'proposed',
  'validating',
  'policyEvaluated',
  'awaitingApproval',
  'approved',
  'rejected',
  'expired',
  'revoked',
  'executing',
  'awaitingVerification',
  'verifying',
  'completed',
  'partial',
  'failed',
  'timedOut',
  'cancelled',
  'unknownEffect',
  'denied',
] as const satisfies readonly AgentToolCallStateV2[];

export const AGENT_TOOL_CALL_TERMINAL_STATES_V2 = [
  'rejected',
  'expired',
  'revoked',
  'completed',
  'partial',
  'failed',
  'timedOut',
  'cancelled',
  'unknownEffect',
  'denied',
] as const satisfies readonly AgentToolCallStateV2[];

export const AGENT_APPROVAL_STATES_V2 = [
  'pending',
  'confirmationPending',
  'approved',
  'rejected',
  'expired',
  'revoked',
  'consuming',
  'consumed',
] as const satisfies readonly AgentApprovalStateV2[];

export const AGENT_APPROVAL_TERMINAL_STATES_V2 = [
  'rejected', 'expired', 'revoked', 'consumed',
] as const satisfies readonly AgentApprovalStateV2[];

export const AGENT_VERIFICATION_STATES_V2 = [
  'pending', 'running', 'satisfied', 'failed', 'inconclusive', 'timedOut', 'cancelled',
] as const satisfies readonly AgentVerificationStateV2[];

export const AGENT_VERIFICATION_TERMINAL_STATES_V2 = [
  'satisfied', 'failed', 'inconclusive', 'timedOut', 'cancelled',
] as const satisfies readonly AgentVerificationStateV2[];

const RUN_TRANSITIONS_V2: Readonly<Record<AgentRunStateV2, readonly AgentRunStateV2[]>> = {
  created: ['collectingContext', 'pausing', 'cancelling', 'failed', 'blocked'],
  collectingContext: ['thinking', 'pausing', 'cancelling', 'failed', 'blocked'],
  thinking: ['validatingTool', 'awaitingUser', 'pausing', 'cancelling', 'completed', 'failed'],
  validatingTool: [
    'thinking', 'evaluatingRisk', 'executingTool', 'pausing', 'cancelling', 'failed', 'blocked',
  ],
  evaluatingRisk: [
    'thinking', 'awaitingApproval', 'pausing', 'cancelling', 'failed', 'blocked',
  ],
  awaitingApproval: ['thinking', 'executingChange', 'pausing', 'cancelling', 'failed'],
  executingTool: ['observing', 'pausing', 'cancelling', 'failed'],
  executingChange: ['verifyingChange', 'pausing', 'cancelling', 'failed'],
  verifyingChange: ['observing', 'pausing', 'cancelling', 'failed'],
  observing: ['thinking', 'pausing', 'cancelling', 'failed'],
  awaitingUser: ['thinking', 'pausing', 'cancelling', 'failed'],
  pausing: ['paused', 'cancelling', 'failed'],
  paused: ['thinking', 'cancelling', 'failed'],
  cancelling: ['cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
  blocked: [],
};

const TOOL_TRANSITIONS_V2: Readonly<Record<AgentToolCallStateV2, readonly AgentToolCallStateV2[]>> = {
  proposed: ['validating', 'cancelled'],
  validating: ['policyEvaluated', 'denied', 'cancelled'],
  policyEvaluated: ['awaitingApproval', 'executing', 'denied', 'cancelled'],
  awaitingApproval: ['approved', 'rejected', 'expired', 'revoked', 'cancelled'],
  approved: ['executing', 'expired', 'revoked', 'cancelled'],
  executing: ['awaitingVerification', 'completed', 'failed', 'timedOut', 'cancelled', 'unknownEffect'],
  awaitingVerification: ['verifying', 'cancelled'],
  verifying: ['completed', 'partial', 'failed', 'timedOut', 'cancelled', 'unknownEffect'],
  rejected: [],
  expired: [],
  revoked: [],
  completed: [],
  partial: [],
  failed: [],
  timedOut: [],
  cancelled: [],
  unknownEffect: [],
  denied: [],
};

const APPROVAL_TRANSITIONS_V2: Readonly<
  Record<AgentApprovalStateV2, readonly AgentApprovalStateV2[]>
> = {
  pending: ['confirmationPending', 'approved', 'rejected', 'expired', 'revoked', 'consuming'],
  confirmationPending: ['approved', 'rejected', 'expired', 'revoked'],
  approved: ['consuming', 'expired', 'revoked'],
  consuming: ['consumed'],
  rejected: [],
  expired: [],
  revoked: [],
  consumed: [],
};

const VERIFICATION_TRANSITIONS_V2: Readonly<
  Record<AgentVerificationStateV2, readonly AgentVerificationStateV2[]>
> = {
  pending: ['running', 'cancelled'],
  running: ['satisfied', 'failed', 'inconclusive', 'timedOut', 'cancelled'],
  satisfied: [],
  failed: [],
  inconclusive: [],
  timedOut: [],
  cancelled: [],
};

export class AgentStateTransitionErrorV2 extends Error {
  constructor(
    readonly machine: 'run' | 'toolCall' | 'approval' | 'verification',
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal Agent v2 ${machine} state transition from ${from} to ${to}`);
    this.name = 'AgentStateTransitionErrorV2';
  }
}

function isMember<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

export const isAgentRunStateV2 = (value: unknown): value is AgentRunStateV2 => (
  isMember(value, AGENT_RUN_STATES_V2)
);
export const isAgentToolCallStateV2 = (value: unknown): value is AgentToolCallStateV2 => (
  isMember(value, AGENT_TOOL_CALL_STATES_V2)
);
export const isAgentApprovalStateV2 = (value: unknown): value is AgentApprovalStateV2 => (
  isMember(value, AGENT_APPROVAL_STATES_V2)
);
export const isAgentVerificationStateV2 = (value: unknown): value is AgentVerificationStateV2 => (
  isMember(value, AGENT_VERIFICATION_STATES_V2)
);

export const canTransitionAgentRunStateV2 = (from: AgentRunStateV2, to: AgentRunStateV2): boolean => (
  RUN_TRANSITIONS_V2[from]?.includes(to) ?? false
);
export const canTransitionAgentToolCallStateV2 = (
  from: AgentToolCallStateV2,
  to: AgentToolCallStateV2,
): boolean => TOOL_TRANSITIONS_V2[from]?.includes(to) ?? false;
export const canTransitionAgentApprovalStateV2 = (
  from: AgentApprovalStateV2,
  to: AgentApprovalStateV2,
): boolean => APPROVAL_TRANSITIONS_V2[from]?.includes(to) ?? false;
export const canTransitionAgentVerificationStateV2 = (
  from: AgentVerificationStateV2,
  to: AgentVerificationStateV2,
): boolean => VERIFICATION_TRANSITIONS_V2[from]?.includes(to) ?? false;

function transition<T extends string>(
  machine: 'run' | 'toolCall' | 'approval' | 'verification',
  from: T,
  to: T,
  allowed: boolean,
): T {
  if (!allowed) throw new AgentStateTransitionErrorV2(machine, from, to);
  return to;
}

export const transitionAgentRunStateV2 = (from: AgentRunStateV2, to: AgentRunStateV2) => (
  transition('run', from, to, canTransitionAgentRunStateV2(from, to))
);
export const transitionAgentToolCallStateV2 = (
  from: AgentToolCallStateV2,
  to: AgentToolCallStateV2,
) => transition('toolCall', from, to, canTransitionAgentToolCallStateV2(from, to));
export const transitionAgentApprovalStateV2 = (
  from: AgentApprovalStateV2,
  to: AgentApprovalStateV2,
) => transition('approval', from, to, canTransitionAgentApprovalStateV2(from, to));
export const transitionAgentVerificationStateV2 = (
  from: AgentVerificationStateV2,
  to: AgentVerificationStateV2,
) => transition('verification', from, to, canTransitionAgentVerificationStateV2(from, to));
