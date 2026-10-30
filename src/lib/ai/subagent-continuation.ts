import type { AgentSessionSnapshot } from '@/types/agent-session';

/** Older saved snapshots still carry the original cumulative wall-clock limit. */
export function childContinuationDeadline(snapshot: AgentSessionSnapshot | null | undefined): number | null {
  const child = snapshot?.header.subagent;
  if (!snapshot || !child) return null;
  return snapshot.childContinuation?.expiresAtUnixMs
    ?? snapshot.header.createdAtUnixMs + child.budget.timeoutMs;
}

export function childBudgetExhausted(snapshot: AgentSessionSnapshot | null | undefined, now = Date.now()): boolean {
  const deadline = childContinuationDeadline(snapshot);
  return deadline !== null && (snapshot?.childContinuation?.budgetExhausted === true || now >= deadline);
}
