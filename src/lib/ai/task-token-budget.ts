import { latestTurnReachedTokenBudget } from './conversation-node';
import type { AiSessionView } from './session-adapter';

/** Only explicit human input can reopen an ended, unarchived root session. */
export function canResumeTokenBudgetedTask(view: AiSessionView | null | undefined): boolean {
  if (!view) return false;
  const session = view.snapshot.value;
  return view.status === 'failed' && session.ended
    && !view.summary.archived && !session.archived
    && !session.header.subagent && !session.header.parentSessionId
    && latestTurnReachedTokenBudget(view.nodes);
}

export function hasTokenBudgetCheckpoint(view: AiSessionView): boolean {
  const latestTurn = [...view.nodes].reverse().find((node) => node.kind === 'turnTail');
  return latestTurn !== undefined && view.nodes.some((node) => node.kind === 'artifact'
    && node.artifactKind === 'task-budget-checkpoint' && node.turnId === latestTurn.turnId);
}

export function taskBudgetArtifactTitleKey(kind: string) {
  if (kind === 'task-budget-progress') return 'ai.workspace.tokenBudget.progressArtifact' as const;
  if (kind === 'task-budget-checkpoint') return 'ai.workspace.tokenBudget.checkpointArtifact' as const;
  return null;
}
