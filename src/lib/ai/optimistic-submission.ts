import type { AiConversationNode, AiUserMessageNode } from './conversation-node';
import type { AiDetachedSubmission } from './composer-machine';
import type { AiInboxItem } from './session-adapter';

export type AiOptimisticDelivery = 'pending' | 'accepted' | 'failed' | 'timedOut';

export interface AiOptimisticSubmission extends AiDetachedSubmission {
  readonly scopeKey: string;
  readonly expectedNextSeq: number | null;
  readonly delivery: AiOptimisticDelivery;
  readonly error?: string;
}

const ASK_RECONCILE_WINDOW_MS = 30_000;

function normalizedContent(content: string): string {
  return content.trim().replace(/\s+/g, ' ');
}

/** Prefer the Agent v3 submission id; retain a bounded content fallback for the formal Ask adapter. */
export function committedOperationId(
  node: AiConversationNode,
  submission: AiOptimisticSubmission,
): boolean {
  if (node.kind !== 'userMessage' || node.delivery !== 'committed' || node.sessionId !== submission.sessionId) {
    return false;
  }
  return observedOperationId(node, submission);
}

function observedOperationId(
  node: AiConversationNode,
  submission: AiOptimisticSubmission,
): boolean {
  if (node.kind !== 'userMessage' || node.sessionId !== submission.sessionId) return false;
  if (node.clientSubmissionId !== undefined) {
    return node.clientSubmissionId === submission.clientOperationId;
  }
  if (node.messageId === submission.clientOperationId || node.turnId === submission.clientOperationId) {
    return true;
  }
  if (submission.expectedNextSeq !== null && node.firstSeq < submission.expectedNextSeq) return false;
  const timestamp = Date.parse(node.timestamp);
  if (
    Number.isFinite(timestamp)
    && Math.abs(timestamp - submission.createdAtUnixMs) > ASK_RECONCILE_WINDOW_MS
  ) {
    return false;
  }
  return normalizedContent(node.content) === normalizedContent(submission.content);
}

export function reconcileOptimisticSubmissions(
  submissions: readonly AiOptimisticSubmission[],
  committedNodes: readonly AiConversationNode[],
  committedInbox: readonly AiInboxItem[] = [],
): {
  readonly remaining: readonly AiOptimisticSubmission[];
  readonly committedOperationIds: readonly string[];
} {
  const committedOperationIds: string[] = [];
  const remaining = submissions.filter((submission) => {
    const committed = committedNodes.some((node) => committedOperationId(node, submission))
      || committedInbox.some((item) => (
        item.clientSubmissionId === submission.clientOperationId
        || (item.clientSubmissionId === undefined && item.id === submission.clientOperationId)
      ));
    if (committed) committedOperationIds.push(submission.clientOperationId);
    return !committed;
  });
  return { remaining, committedOperationIds };
}

function optimisticNode(submission: AiOptimisticSubmission): AiUserMessageNode {
  return {
    kind: 'userMessage',
    key: `optimistic:${submission.clientOperationId}`,
    sourceKind: submission.scopeKey.startsWith('ask:') ? 'ask' : 'agent',
    sessionId: submission.sessionId ?? submission.scopeKey,
    turnId: submission.clientOperationId,
    stepId: null,
    firstSeq: submission.expectedNextSeq ?? Number.MAX_SAFE_INTEGER,
    lastSeq: submission.expectedNextSeq ?? Number.MAX_SAFE_INTEGER,
    timestamp: new Date(submission.createdAtUnixMs).toISOString(),
    messageId: submission.clientOperationId,
    clientSubmissionId: submission.clientOperationId,
    content: submission.content,
    delivery: submission.delivery === 'failed' || submission.delivery === 'timedOut'
      ? 'failed'
      : 'pending',
  };
}

export function withOptimisticConversationNodes(
  committedNodes: readonly AiConversationNode[],
  submissions: readonly AiOptimisticSubmission[],
  scopeKey: string,
  sessionId: string | null,
  committedInbox: readonly AiInboxItem[] = [],
): readonly AiConversationNode[] {
  const deduplicated = [...new Map(committedNodes.map((node) => [node.key, node])).values()];
  const visible = submissions.filter((submission) => (
    submission.scopeKey === scopeKey
    && (submission.sessionId === null || sessionId === null || submission.sessionId === sessionId)
    && !committedInbox.some((item) => (
      item.clientSubmissionId === submission.clientOperationId
      || (item.clientSubmissionId === undefined && item.id === submission.clientOperationId)
    ))
    && !deduplicated.some((node) => observedOperationId(node, submission))
  ));
  return [...deduplicated, ...visible.map(optimisticNode)];
}
