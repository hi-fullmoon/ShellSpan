import { describe, expect, it } from 'vitest';
import { latestFailureRecovery, modelFailureRecovery, modelRetryConfirmation } from '../failure-recovery';
import { agentSessionView } from '../agent-session-adapter';
import { agentSessionFailedEventFixture, sessionEvent } from '@/test/fixtures/agent-session';
import type { AiErrorNode } from '../conversation-node';
import type { AgentSessionEvent } from '@/types/agent-session';

function failedEvents(failure: NonNullable<AiErrorNode['failure']>): AgentSessionEvent[] {
  const prefix = agentSessionFailedEventFixture.slice(0, 5);
  return [...prefix,
    sessionEvent(5, { turnId: 'turn-failed', stepId: 'step-failed', type: 'request/failure',
      data: { requestId: 'failed', attempt: 3, maxAttempts: 3, cumulativeDelayMs: 750, interrupted: false, failure } }),
    sessionEvent(6, { turnId: 'turn-failed', stepId: 'step-failed', type: 'step/end', data: { reason: 'rateLimited: HTTP_429' } }),
    sessionEvent(7, { turnId: 'turn-failed', type: 'turn/end', data: { reason: 'rateLimited: HTTP_429' } }),
    sessionEvent(8, { type: 'session/ended', data: { status: 'failed', reason: 'rateLimited: HTTP_429' } }),
  ];
}

function viewFor(events: readonly AgentSessionEvent[]) {
  // Use the production event projection, including the native snapshot schema.
  const created = events[0];
  if (created.type !== 'session/created') throw new Error('Missing session creation');
  return agentSessionView({
    events, lastCommittedSeq: events.length - 1, hasTerminalEvent: true,
    snapshot: {
      header: { sessionId: created.sessionId, taskId: created.data.taskId, goal: created.data.goal,
        createdAtUnixMs: created.timeUnixMs, target: created.data.target, permissionMode: 'requestApproval',
        executionSurface: 'direct', successCriteria: created.data.successCriteria },
      status: 'failed', ended: true, archived: false, eventCount: events.length,
      surface: { generation: 0, messages: [] }, inbox: { nextTurn: [], nextStep: [], pausedIds: [] },
      task: { evidence: [] },
      recovery: { status: 'none', kind: 'terminal', summary: '', lastCommittedSeq: events.length - 1 },
    },
  });
}

describe('failure recovery', () => {
  it('keeps explicit recovery available for its own paused input after restart', () => {
    const events = failedEvents({ kind: 'transport', message: 'connection interrupted' });
    const message = {
      messageId: 'model-retry-turn-failed', clientSubmissionId: 'model-retry-turn-failed',
      content: 'Continue the existing request', source: { kind: 'runtime' as const,
        label: 'model-failure-retry', producerId: 'shellspan-runtime', metadata: { retryTurnId: 'turn-failed' } },
    };
    const view = viewFor([...events,
      sessionEvent(9, { type: 'session/resumed', data: {} }),
      sessionEvent(10, { type: 'agent/inbox/spliced', data: { operation: 'enqueued', lane: 'nextTurn', messages: [message] } }),
      sessionEvent(11, { type: 'agent/inbox/paused', data: { itemIds: [message.messageId] } }),
    ]);
    expect(view.inbox).toEqual([expect.objectContaining({ paused: true, state: 'queued' })]);
    const confirm = modelRetryConfirmation(view, 'turn-failed');
    expect(confirm(view)).toBe(false);
    const resumed = viewFor([...events,
      sessionEvent(9, { type: 'session/resumed', data: {} }),
      sessionEvent(10, { type: 'agent/inbox/spliced', data: { operation: 'enqueued', lane: 'nextTurn', messages: [message] } }),
      sessionEvent(11, { type: 'agent/inbox/paused', data: { itemIds: [message.messageId] } }),
      sessionEvent(12, { type: 'agent/inbox/item_resumed', data: { itemId: message.messageId, previousRevision: 12, clientOperationId: 'explicit-resume' } }),
    ]);
    expect(confirm(resumed)).toBe(true);
    const confirmScheduling = modelRetryConfirmation(resumed, 'turn-failed');
    expect(confirmScheduling(resumed)).toBe(false);
    expect(confirmScheduling({ ...resumed, inbox: resumed.inbox.map(item => ({ ...item, state: 'claimed' })) })).toBe(true);
    expect(latestFailureRecovery(view)).toMatchObject({ kind: 'retry', turnId: 'turn-failed' });
    expect(latestFailureRecovery({ ...view, inbox: view.inbox.map(item => ({ ...item, paused: false })) })).toBeNull();
    expect(latestFailureRecovery({ ...view, inbox: view.inbox.map(item => ({ ...item, provenance: { ...message.source, metadata: { retryTurnId: 'old-turn' } } })) })).toBeNull();
  });
  it('distinguishes quota exhaustion and policy refusal from temporary limits', () => {
    const view = viewFor(failedEvents({ kind: 'rateLimited', status: 429, code: 'insufficient_quota', message: 'quota exhausted' }));
    expect(latestFailureRecovery(view)).toMatchObject({ kind: 'settings' });
    const refused = viewFor(failedEvents({ kind: 'terminal', status: 403, code: 'content_policy_violation', message: 'request declined' }));
    expect(latestFailureRecovery(refused)).toMatchObject({ kind: 'input' });
  });
  it('preserves typed failure and provider cooldown in the production projection', () => {
    const events = failedEvents({ kind: 'rateLimited', status: 429, message: 'capacity', retryAfterMs: 60_000 });
    const view = viewFor(events);
    expect(latestFailureRecovery(view)).toEqual({ kind: 'retry', turnId: 'turn-failed', retryAt: events[5].timeUnixMs + 60_000 });
    expect(view.nodes.filter(node => node.kind === 'userMessage')).toHaveLength(1);
    expect(latestFailureRecovery({ ...view, syncError: { kind: 'offline', message: 'sync unavailable', retryable: true } })).toBeNull();
    expect(latestFailureRecovery({ ...view, status: 'running' })).toBeNull();
    expect(latestFailureRecovery({ ...view, snapshot: { ...view.snapshot, value: { ...view.snapshot.value, archived: true } } })).toBeNull();
    expect(latestFailureRecovery({ ...view, snapshot: { ...view.snapshot, value: { ...view.snapshot.value, uncertainNativeEffects: true } } })).toMatchObject({ kind: 'verify' });
  });

  it.each([
    ['transport', undefined, 'retry'], ['timeout', undefined, 'retry'], ['emptyResponse', undefined, 'retry'],
    ['retryable', 503, 'retry'], ['retryable', 402, 'settings'], ['authentication', 401, 'settings'],
    ['terminal', 404, 'settings'], ['contextTooLarge', undefined, 'input'], ['protocol', undefined, 'input'],
    ['cancelled', undefined, 'input'],
  ] as const)('classifies %s / %s by structured fields', (kind, status, expected) => {
    const view = viewFor(failedEvents({ kind, status, message: 'opaque provider text' }));
    const process = view.nodes.find(node => node.kind === 'turnProcess');
    const error = process?.kind === 'turnProcess' ? process.children.find((node): node is AiErrorNode => node.kind === 'error') : undefined;
    expect(error).toBeDefined();
    expect(modelFailureRecovery(error!)).toBe(expected);
  });
});
