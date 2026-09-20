import { describe, expect, it } from 'vitest';
import { canResumeTokenBudgetedTask, hasTokenBudgetCheckpoint } from '../task-token-budget';
import { taskTokenBudgetView } from '@/test/fixtures/task-token-budget';

describe('persisted task token budget recovery', () => {
  it('allows only an ended, unarchived root and removes recovery after resume', () => {
    const view = taskTokenBudgetView();
    expect(canResumeTokenBudgetedTask(view)).toBe(true);
    expect(canResumeTokenBudgetedTask(taskTokenBudgetView(true))).toBe(false);
    expect(canResumeTokenBudgetedTask(null)).toBe(false);
    expect(canResumeTokenBudgetedTask({ ...view, summary: { ...view.summary, archived: true } })).toBe(false);
    for (const snapshot of [
      { ...view.snapshot.value, archived: true },
      { ...view.snapshot.value, ended: false },
      { ...view.snapshot.value, header: { ...view.snapshot.value.header, parentSessionId: 'parent' } },
    ]) expect(canResumeTokenBudgetedTask({ ...view, snapshot: { kind: 'agent', value: snapshot } })).toBe(false);
  });

  it('only claims a saved summary when the failed turn contains its artifact', () => {
    const view = taskTokenBudgetView();
    expect(hasTokenBudgetCheckpoint(view)).toBe(true);
    expect(hasTokenBudgetCheckpoint({ ...view, nodes: view.nodes.filter((node) => node.kind !== 'artifact') })).toBe(false);
    expect(hasTokenBudgetCheckpoint({ ...view, nodes: view.nodes.map((node) => node.kind === 'artifact'
      ? { ...node, turnId: 'earlier-turn' } : node) })).toBe(false);
  });
});
