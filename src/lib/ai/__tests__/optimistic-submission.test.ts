import { describe, expect, it } from 'vitest';

import {
  reconcileOptimisticSubmissions,
  withOptimisticConversationNodes,
  type AiOptimisticSubmission,
} from '@/lib/ai/optimistic-submission';
import type { AiUserMessageNode } from '@/lib/ai/conversation-node';

function pending(changes: Partial<AiOptimisticSubmission> = {}): AiOptimisticSubmission {
  return {
    clientOperationId: 'operation-1',
    sessionId: 'session-1',
    content: 'Run the checks',
    mode: 'nextTurn',
    createdAtUnixMs: 1_000,
    scopeKey: 'agent:terminal:terminal-1',
    expectedNextSeq: 12,
    delivery: 'accepted',
    ...changes,
  };
}

function committed(changes: Partial<AiUserMessageNode> = {}): AiUserMessageNode {
  return {
    kind: 'userMessage',
    key: 'user:12',
    sourceKind: 'agent',
    sessionId: 'session-1',
    turnId: 'turn-1',
    stepId: null,
    firstSeq: 12,
    lastSeq: 12,
    timestamp: new Date(1_100).toISOString(),
    messageId: 'operation-1',
    clientSubmissionId: 'operation-1',
    content: 'Run the checks',
    delivery: 'committed',
    ...changes,
  };
}

describe('optimistic submission reconcile', () => {
  it('atomically replaces an exact operation id with one committed user node', () => {
    const result = reconcileOptimisticSubmissions([pending()], [committed()]);
    expect(result.remaining).toEqual([]);
    expect(result.committedOperationIds).toEqual(['operation-1']);
    expect(withOptimisticConversationNodes([committed(), committed()], [pending()], pending().scopeKey, 'session-1'))
      .toEqual([committed()]);
  });

  it('does not content-match nodes without a durable submission id', () => {
    const node = committed({
      messageId: 'runtime-message', turnId: 'turn-1', clientSubmissionId: undefined,
    });
    expect(reconcileOptimisticSubmissions([pending()], [node]).remaining).toHaveLength(1);
  });

  it('never content-matches a node carrying another durable submission id', () => {
    const node = committed({
      messageId: 'runtime-message',
      clientSubmissionId: 'operation-other',
      content: pending().content,
    });
    expect(reconcileOptimisticSubmissions([pending()], [node]).remaining).toHaveLength(1);
  });

  it('reconciles a durable Queue/Steer inbox item before it becomes a user node', () => {
    expect(reconcileOptimisticSubmissions([pending()], [], [{
      id: 'runtime-message', clientSubmissionId: 'operation-1', lane: 'nextTurn',
      content: 'Run the checks', state: 'queued', source: 'user',
    }])).toEqual({ remaining: [], committedOperationIds: ['operation-1'] });
  });

  it('keeps failed and timed-out delivery visible for retry', () => {
    const nodes = withOptimisticConversationNodes([], [
      pending({ delivery: 'failed' }),
      pending({ clientOperationId: 'operation-2', delivery: 'timedOut' }),
    ], pending().scopeKey, 'session-1');
    expect(nodes).toHaveLength(2);
    expect(nodes.every((node) => node.kind === 'userMessage' && node.delivery === 'failed')).toBe(true);
  });

  it('uses an adapter-projected failed user node as the single visible failure without committing it', () => {
    const failedNode = committed({ delivery: 'failed' });
    expect(reconcileOptimisticSubmissions([pending({ delivery: 'failed' })], [failedNode]).remaining)
      .toHaveLength(1);
    expect(withOptimisticConversationNodes(
      [failedNode], [pending({ delivery: 'failed' })], pending().scopeKey, 'session-1',
    )).toEqual([failedNode]);
  });

  it('never displays a submission in another session or workspace scope', () => {
    expect(withOptimisticConversationNodes([], [pending()], pending().scopeKey, 'session-2')).toEqual([]);
    expect(withOptimisticConversationNodes([], [pending()], 'agent:terminal:terminal-2', 'session-1')).toEqual([]);
  });
});
