import { describe, expect, it } from 'vitest';
import { agentSessionView } from '../agent-session-adapter';
import { questionIssue, questionSubmissionIssue, reconcileQuestionSubmission } from '../question-submission';
import { agentSessionEventFixture, sessionEvent } from '@/test/fixtures/agent-session';
import type { AgentSessionSnapshot } from '@/types/agent-session';
import type { AnswerQuestionInput, AgentQuestionView } from '@/types/agent-question';

const input: AnswerQuestionInput = {
  identity: { sessionId: 'session-fixture', turnId: 'turn-1', stepId: 'step-1', requestId: 'request-1', callId: 'question-call', questionRequestId: 'question-id' },
  clientOperationId: 'question-operation',
  answers: [{ id: 'choice', selected: [], custom: 'Answer' }],
};
const question: AgentQuestionView = {
  identity: input.identity, questions: [{ id: 'choice', question: 'Choose?', multi_select: false }],
  status: 'pending', answers: [], firstSeq: 1, lastSeq: 1, timestamp: '2026-09-04T00:00:00Z',
};
const snapshot: AgentSessionSnapshot = {
  header: { sessionId: input.identity.sessionId, taskId: 'task-fixture', goal: 'Check nginx and report evidence.', executionSurface: 'direct', createdAtUnixMs: 1000 },
  status: 'running', ended: false, archived: false, eventCount: agentSessionEventFixture.length,
  surface: { generation: 0, messages: [] }, inbox: { nextTurn: [], nextStep: [] }, task: { evidence: [] },
  recovery: { kind: 'idle', status: 'none', summary: '', lastCommittedSeq: 0 },
};
const events = [...agentSessionEventFixture.slice(0, 10), sessionEvent(10, {
  type: 'question/requested', turnId: input.identity.turnId, stepId: input.identity.stepId,
  data: { identity: input.identity, arguments: { questions: question.questions }, provider: { routeId: 'fixture', modelId: 'fixture' } },
})];
const view = agentSessionView({ snapshot, events, hasTerminalEvent: false });

describe('question submission recovery', () => {
  it.each([
    ['question cannot bypass required recovery reconciliation', 'recovery', false, false],
    ['question was cancelled', 'cancelled', false, false],
    ['question Session has ended', 'ended', false, false],
    ['unknown or stale question identity', 'inactive', false, false],
    ['question answer conflicts with its committed answer', 'conflict', false, false],
    ['unknown or duplicate selected option', 'invalid', false, true],
    ['question payload exceeds 32768 bytes', 'invalid', false, true],
    ['UNKNOWN_ROUTE: deepseek', 'model', true, false],
    ['UNKNOWN_MODEL', 'model', true, false],
    ['question continuation requires provider credentials', 'model', true, false],
    ['network connection lost', 'offline', true, false],
    ['provider request timed out', 'offline', true, false],
    ['disk I/O error', 'unconfirmed', true, false],
  ] as const)('preserves the actual runtime diagnostic %s', (error, reason, retry, editable) => {
    expect(questionSubmissionIssue(new Error(error))).toEqual({ reason, detail: error, retry, editable });
  });

  it('does not unlock answers when confirmation fails with validation-like text', () => {
    expect(questionSubmissionIssue('unknown answer id', 'confirm')).toMatchObject({ reason: 'confirmation', editable: false, retry: true });
  });

  it('redacts secrets before retaining and bounding the diagnostic', () => {
    const issue = questionSubmissionIssue({ message: 'API key is invalid', apiKey: 'private-value' });
    expect(issue.reason).toBe('model');
    expect(issue.detail).not.toContain('private-value');
    expect(questionSubmissionIssue(`password=private-value ${'x'.repeat(5000)}`).detail).not.toContain('private-value');
    expect(questionSubmissionIssue('x'.repeat(5000)).detail).toHaveLength(4096);
  });

  it('acknowledges a committed operation even after a failed request or synchronization', () => {
    expect(reconcileQuestionSubmission(input, { ...view, committedOperationIds: [input.clientOperationId], syncError: { kind: 'offline', message: 'connection lost', retryable: true } }, questionSubmissionIssue('connection lost'))).toBeNull();
  });

  it('keeps answers frozen when fresh synchronization cannot establish the result', () => {
    expect(reconcileQuestionSubmission(input, { ...view, syncError: { kind: 'offline', message: 'connection lost', retryable: true } }, questionSubmissionIssue('unknown answer id')))
      .toMatchObject({ reason: 'confirmation', retry: true, editable: false });
  });

  it('offers retry after a read-only refresh finds the original question pending', () => {
    expect(reconcileQuestionSubmission(input, view)).toEqual(questionIssue('pending'));
    expect(reconcileQuestionSubmission(input, view, questionSubmissionIssue('unknown answer id'))).toMatchObject({ reason: 'invalid', editable: true });
  });

  it.each(['required', 'reconciling'] as const)('does not retry through %s recovery', status => {
    expect(reconcileQuestionSubmission(input, { ...view, recovery: { status, summary: 'execution reconciliation required' } }))
      .toMatchObject({ reason: 'recovery', retry: false, editable: false });
  });

  it('uses actual cancelled, ended and inactive states instead of the old error', () => {
    const previous = questionSubmissionIssue('network connection lost');
    expect(reconcileQuestionSubmission(input, { ...view, status: 'cancelled' }, previous)?.reason).toBe('cancelled');
    expect(reconcileQuestionSubmission(input, { ...view, snapshot: { kind: 'agent', value: { ...snapshot, ended: true } } }, previous)?.reason).toBe('ended');
    expect(reconcileQuestionSubmission(input, { ...view, pendingQuestion: null }, previous)?.reason).toBe('inactive');
  });

  it('does not accept an operation ID from another session', () => {
    expect(reconcileQuestionSubmission(input, { ...view, summary: { ...view.summary, id: 'other-session' }, committedOperationIds: [input.clientOperationId] }))
      .toMatchObject({ reason: 'unconfirmed', editable: false });
  });

  it('recognizes answered and cancelled questions from committed events', () => {
    const cancelled = agentSessionView({ snapshot, hasTerminalEvent: false, events: [...events, sessionEvent(11, {
      type: 'question/cancelled', turnId: input.identity.turnId, stepId: input.identity.stepId, data: { identity: input.identity },
    })] });
    expect(reconcileQuestionSubmission(input, cancelled)?.reason).toBe('cancelled');
    const answered = agentSessionView({ snapshot, hasTerminalEvent: false, events: [...events, sessionEvent(11, {
      type: 'question/answered', turnId: input.identity.turnId, stepId: input.identity.stepId,
      data: { submission: input, fingerprint: '0'.repeat(64) },
    })] });
    expect(reconcileQuestionSubmission(input, answered)).toBeNull();
    expect(reconcileQuestionSubmission({ ...input, clientOperationId: 'other-operation' }, answered)?.reason).toBe('conflict');
  });
});
