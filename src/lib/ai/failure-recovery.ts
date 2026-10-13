import type { AiConversationNode, AiErrorNode } from './conversation-node';
import type { AiSessionView } from './session-adapter';

export type AiFailureRecovery = Readonly<{
  turnId: string;
  kind: 'retry' | 'settings' | 'input' | 'verify';
  retryAt?: number;
}>;

export function modelFailureRecovery(error: AiErrorNode): AiFailureRecovery['kind'] {
  // A later context pause supersedes an earlier provider failure on this turn.
  if (error.message.startsWith('contextBudgetExceeded:')) return 'input';
  const failure = error.failure;
  if (!failure) return 'input';
  // Status and typed codes take precedence over a broad retryable category.
  const code = failure.code?.toLowerCase();
  if (code === 'content_policy_violation' || code === 'context_length_exceeded' || code === 'invalid_request_error') return 'input';
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached' || code === 'model_not_found') return 'settings';
  if (failure.kind === 'authentication' || [401, 402, 403, 404].includes(failure.status ?? 0)) return 'settings';
  if (['retryable', 'transport', 'timeout', 'emptyResponse', 'rateLimited'].includes(failure.kind)) return 'retry';
  return 'input';
}

/** Admission and explicit resume have different durable acknowledgement rules. */
export function modelRetryConfirmation(before: AiSessionView, turnId: string): (view: AiSessionView) => boolean {
  const id = `model-retry-${turnId}`;
  const original = before.inbox.find(item => item.clientSubmissionId === id && !item.consumed);
  return view => {
    if (!view.committedOperationIds?.includes(id)) return false;
    const pending = view.inbox.find(item => item.clientSubmissionId === id && !item.consumed);
    if (pending?.paused) return false;
    return !original || original.paused || !pending || pending.state === 'claimed';
  };
}

/** Only a complete, settled latest turn can offer a recovery operation. */
export function latestFailureRecovery(view: AiSessionView): AiFailureRecovery | null {
  const snapshot = view.snapshot.value;
  if (snapshot.archived || snapshot.header.subagent || view.syncError
    || view.pendingApproval || view.pendingQuestion
    || !['failed', 'idle'].includes(view.status)) return null;
  let latest: AiConversationNode | undefined;
  for (let index = view.nodes.length - 1; index >= 0; index -= 1) {
    const node = view.nodes[index];
    if (node?.kind === 'turnProcess') { latest = node; break; }
  }
  if (latest?.kind !== 'turnProcess' || latest.status !== 'failed'
    || !latest.hasStartBoundary || !latest.hasEndBoundary || !latest.turnId) return null;
  const error = [...latest.children].reverse().find((node): node is AiErrorNode => node.kind === 'error' && node.state === 'failed');
  if (!error) return null;
  const kind = modelFailureRecovery(error);
  if (kind !== 'retry') return { turnId: latest.turnId, kind };
  if (snapshot.uncertainNativeEffects || latest.children.some(node => node.kind === 'tool' || node.kind === 'question')) {
    return { turnId: latest.turnId, kind: 'verify' };
  }
  const pending = view.inbox.filter(item => !item.consumed);
  // A restart pauses the durable recovery input. Keep its human recovery action
  // visible, while other queued work continues to block a new retry.
  if (pending.some(item => item.source !== 'runtime'
    || item.provenance?.label !== 'model-failure-retry'
    || item.provenance.metadata?.retryTurnId !== latest.turnId
    || item.state !== 'queued' || !item.paused)) return null;
  return { turnId: latest.turnId, kind, retryAt: error.retryAt };
}
