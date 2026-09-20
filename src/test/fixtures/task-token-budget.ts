import capture from './task-token-budget.json';
import { agentSessionView } from '@/lib/ai/agent-session-adapter';
import type { AgentSessionEvent, AgentSessionSnapshot } from '@/types/agent-session';

// Captured from task_token_budget_checkpoint_survives_restart_and_explicit_resume
// using the real Rust session/artifact stores. No model transport is simulated.
export const taskTokenBudgetEvidence = capture as unknown as Readonly<{
  failed: AgentSessionSnapshot;
  events: readonly AgentSessionEvent[];
  continued: AgentSessionSnapshot;
  continuedEvents: readonly AgentSessionEvent[];
}>;

export function taskTokenBudgetView(continued = false) {
  const snapshot = continued ? taskTokenBudgetEvidence.continued : taskTokenBudgetEvidence.failed;
  const events = continued ? taskTokenBudgetEvidence.continuedEvents : taskTokenBudgetEvidence.events;
  return agentSessionView({ snapshot, events,
    lastCommittedSeq: events[events.length - 1]?.seq, hasTerminalEvent: !continued });
}
