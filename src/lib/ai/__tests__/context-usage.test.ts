import { describe, expect, it } from 'vitest';
import { projectContextUsage } from '../context-usage';
import type { AgentSessionEvent } from '@/types/agent-session';
import capture from '@/test/fixtures/context-usage-runtime.json';
import skillsCapture from '@/test/fixtures/agent-skills-runtime.json';
import budgetEvidence from '@/test/fixtures/context-budget-review.json';

// Accounting-only excerpts from the actual 2026-10-27 session. No message
// bodies, tool arguments, credentials, or fabricated usage are retained.
const transitions = capture.requestTransitions as readonly AgentSessionEvent[];
const compaction = capture.compaction as readonly AgentSessionEvent[];
const through = (events: readonly AgentSessionEvent[], seq: number) =>
  projectContextUsage(events.filter(event => event.seq <= seq));

describe('context usage from committed runtime accounting', () => {
  it('projects observed request budgets separately from confirmed usage and clears them on compaction', () => {
    const requestBudget = {
      outputTokens: budgetEvidence.budget.outputReserveTokens,
      safetyTokens: budgetEvidence.budget.safetyReserveTokens,
      usableInputTokens: budgetEvidence.budget.usableInputTokens,
      compactionThresholdTokens: budgetEvidence.budget.compactionThresholdTokens,
      compactionTargetTokens: budgetEvidence.budget.compactionTargetTokens,
    };
    // Supply the new event field from the same session's recorded budget artifact.
    const observed = (budgetEvidence.events as readonly AgentSessionEvent[]).map(event => event.type === 'request/context'
      ? { ...event, data: { ...event.data, requestBudget } } : event);
    expect(projectContextUsage(observed)).toMatchObject({
      usedTokens: 46_517, estimatedTokens: 51_925, contextWindow: 200_000, requestBudget,
    });
    expect(projectContextUsage(budgetEvidence.events as readonly AgentSessionEvent[])).not.toHaveProperty('requestBudget');
    const actualReset = budgetEvidence.compaction as AgentSessionEvent;
    const resetEvents = [...observed, actualReset];
    expect(projectContextUsage(resetEvents)?.requestBudget).toBeUndefined();
  });
  it('keeps confirmed input when the next request starts', () => {
    expect(through(transitions, 6507)).toMatchObject({
      usedTokens: 80_998, source: 'reported', estimatedTokens: 116_893,
      breakdown: { systemTokens: 2162, toolsTokens: 6848, messageTokens: 107883 },
    });
    expect(through(transitions, 6684)).toMatchObject({ usedTokens: 85_288, source: 'reported' });
    expect(through(transitions, 6710)).toMatchObject({ usedTokens: 85_288, source: 'reported', estimatedTokens: 127_876 });
  });

  it('clears confirmed usage and the old estimate at successful compaction', () => {
    expect(through(compaction, 5640)).toMatchObject({ usedTokens: 141_616, source: 'reported' });
    expect(through(compaction, 5666)).toEqual({ contextWindow: 312_000, usedTokens: null, source: 'pending', afterCompaction: true });
    expect(through(compaction, 5672)).toMatchObject({ usedTokens: 62_473, source: 'estimated', estimatedTokens: 62_473, afterCompaction: true });
    const confirmed = through(compaction, 5977);
    expect(confirmed).toMatchObject({ usedTokens: 49_322, source: 'reported', estimatedTokens: 62_473 });
    expect(confirmed).not.toHaveProperty('afterCompaction');
  });

  it('uses estimates when the real provider supplies no input counters', () => {
    expect(projectContextUsage(skillsCapture as readonly AgentSessionEvent[])).toMatchObject({
      usedTokens: 9196, estimatedTokens: 9196, source: 'estimated',
    });
  });

  it('ignores accounting from old contexts after a surface reset', () => {
    const old = compaction.filter(event => event.seq <= 5640);
    const current = compaction.filter(event => event.seq >= 5666);
    // A backfilled old response cannot revive its discarded surface.
    expect(projectContextUsage([...old, ...current, old[1]])).toMatchObject({
      usedTokens: 49_322, source: 'reported', estimatedTokens: 83_735,
    });
  });
});
