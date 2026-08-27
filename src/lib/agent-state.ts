import type { AgentRunStateV1, AgentToolCallStateV1 } from '@/types/agent';

export const AGENT_RUN_STATES_V1 = [
  'created',
  'collectingContext',
  'thinking',
  'validatingTool',
  'executingTool',
  'observing',
  'awaitingUser',
  'pausing',
  'paused',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'blocked',
] as const satisfies readonly AgentRunStateV1[];

export const AGENT_RUN_TERMINAL_STATES_V1 = [
  'completed',
  'failed',
  'cancelled',
  'blocked',
] as const satisfies readonly AgentRunStateV1[];

export const AGENT_TOOL_CALL_STATES_V1 = [
  'proposed',
  'validating',
  'executing',
  'completed',
  'failed',
  'timedOut',
  'cancelled',
  'denied',
] as const satisfies readonly AgentToolCallStateV1[];

export const AGENT_TOOL_CALL_TERMINAL_STATES_V1 = [
  'completed',
  'failed',
  'timedOut',
  'cancelled',
  'denied',
] as const satisfies readonly AgentToolCallStateV1[];

const RUN_TRANSITIONS_V1: Readonly<Record<AgentRunStateV1, readonly AgentRunStateV1[]>> = {
  created: ['collectingContext', 'pausing', 'cancelling', 'failed', 'blocked'],
  collectingContext: ['thinking', 'pausing', 'cancelling', 'failed', 'blocked'],
  thinking: ['validatingTool', 'awaitingUser', 'pausing', 'cancelling', 'completed', 'failed'],
  validatingTool: ['thinking', 'executingTool', 'pausing', 'cancelling', 'failed', 'blocked'],
  executingTool: ['observing', 'pausing', 'cancelling', 'failed'],
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

const TOOL_TRANSITIONS_V1: Readonly<Record<AgentToolCallStateV1, readonly AgentToolCallStateV1[]>> = {
  proposed: ['validating', 'cancelled'],
  validating: ['executing', 'denied', 'cancelled'],
  executing: ['completed', 'failed', 'timedOut', 'cancelled'],
  completed: [],
  failed: [],
  timedOut: [],
  cancelled: [],
  denied: [],
};

export class AgentStateTransitionError extends Error {
  readonly machine: 'run' | 'toolCall';
  readonly from: AgentRunStateV1 | AgentToolCallStateV1;
  readonly to: AgentRunStateV1 | AgentToolCallStateV1;

  constructor(
    machine: 'run' | 'toolCall',
    from: AgentRunStateV1 | AgentToolCallStateV1,
    to: AgentRunStateV1 | AgentToolCallStateV1,
  ) {
    super(`Illegal Agent ${machine} state transition from ${from} to ${to}`);
    this.name = 'AgentStateTransitionError';
    this.machine = machine;
    this.from = from;
    this.to = to;
  }
}

export function isAgentRunStateV1(value: unknown): value is AgentRunStateV1 {
  return typeof value === 'string' && AGENT_RUN_STATES_V1.includes(value as AgentRunStateV1);
}

export function isAgentToolCallStateV1(value: unknown): value is AgentToolCallStateV1 {
  return typeof value === 'string'
    && AGENT_TOOL_CALL_STATES_V1.includes(value as AgentToolCallStateV1);
}

export function isAgentRunTerminalStateV1(state: AgentRunStateV1): boolean {
  return AGENT_RUN_TERMINAL_STATES_V1.includes(
    state as (typeof AGENT_RUN_TERMINAL_STATES_V1)[number],
  );
}

export function isAgentToolCallTerminalStateV1(state: AgentToolCallStateV1): boolean {
  return AGENT_TOOL_CALL_TERMINAL_STATES_V1.includes(
    state as (typeof AGENT_TOOL_CALL_TERMINAL_STATES_V1)[number],
  );
}

export function canTransitionAgentRunStateV1(
  from: AgentRunStateV1,
  to: AgentRunStateV1,
): boolean {
  return RUN_TRANSITIONS_V1[from].includes(to);
}

export function transitionAgentRunStateV1(
  from: AgentRunStateV1,
  to: AgentRunStateV1,
): AgentRunStateV1 {
  if (!canTransitionAgentRunStateV1(from, to)) {
    throw new AgentStateTransitionError('run', from, to);
  }
  return to;
}

export function canTransitionAgentToolCallStateV1(
  from: AgentToolCallStateV1,
  to: AgentToolCallStateV1,
): boolean {
  return TOOL_TRANSITIONS_V1[from].includes(to);
}

export function transitionAgentToolCallStateV1(
  from: AgentToolCallStateV1,
  to: AgentToolCallStateV1,
): AgentToolCallStateV1 {
  if (!canTransitionAgentToolCallStateV1(from, to)) {
    throw new AgentStateTransitionError('toolCall', from, to);
  }
  return to;
}
