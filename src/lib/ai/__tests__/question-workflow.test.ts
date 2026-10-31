import { describe, expect, it } from 'vitest';
import { projectQuestions } from '../question-projection';
import { projectAgentActivity } from '../agent-session-projection';
import { pendingUserAction, type AnswerQuestionInput } from '@/types/agent-question';
import type { AgentSessionEvent } from '@/types/agent-session';

const identity = { sessionId: 'workflow', turnId: 'turn', stepId: 'step', requestId: 'request', callId: 'call', questionRequestId: 'question' };
const action = { instructions: 'Complete access configuration, then confirm.', verification_command: 'test -r /etc/hosts' };
const input: AnswerQuestionInput = { identity, clientOperationId: 'selection', answers: [{ id: 'access', selected: ['Configure access'] }] };
const base = { version: 5, sessionId: identity.sessionId, turnId: identity.turnId, stepId: identity.stepId, timeUnixMs: 1 } as const;
const requested: AgentSessionEvent = {
  ...base, seq: 0, type: 'question/requested', data: { identity, provider: { routeId: 'route', modelId: 'model' },
    arguments: { questions: [{ id: 'access', question: 'Choose access method', multi_select: false,
      options: [{ label: 'Configure access', user_action: action }, { label: 'Another connection' }] }] } },
};
const selected: AgentSessionEvent = { ...base, seq: 1, type: 'question/answered', data: { submission: input, fingerprint: '0'.repeat(64) } };

describe('durable user interaction workflow projections', () => {
  it('keeps the selected plan pending without asking for it again', () => {
    const [question] = projectQuestions([requested, selected]);
    expect(question.status).toBe('pending');
    expect(question.answers).toEqual(input.answers);
    expect(pendingUserAction(question)).toEqual(action);
    expect(projectAgentActivity([requested, selected]).nodes.find(n => n.kind === 'question')?.status).toBe('pending');
  });

  it.each(['completed', 'change_plan', 'cancelled'] as const)('records %s separately from the choice and replays it', response => {
    const result: AgentSessionEvent = { ...base, seq: 2, type: 'question/action_answered', data: {
      submission: { ...input, clientOperationId: 'completion', action: response }, fingerprint: '1'.repeat(64),
    } };
    const [question] = projectQuestions([requested, selected, result]);
    expect(question.status).toBe('answered');
    expect(question.actionResponse).toBe(response);
    expect(question.answers).toEqual(input.answers);
    expect(pendingUserAction(question)).toBeUndefined();
    expect(projectQuestions(JSON.parse(JSON.stringify([requested, selected, result])))).toEqual([question]);
  });

  it('supports a standalone user operation without text answers', () => {
    const direct: AgentSessionEvent = { ...requested, data: { ...requested.data, arguments: {
      questions: [{ id: 'manual', question: action.instructions, multi_select: false, user_action: action }],
    } } };
    expect(pendingUserAction(projectQuestions([direct])[0])).toEqual(action);
    const complete: AgentSessionEvent = { ...selected, data: { ...selected.data, submission: { ...input, answers: [], action: 'completed' } } };
    expect(projectQuestions([direct, complete])[0].status).toBe('answered');
  });

  it('retains the committed choice when an unfinished user operation is interrupted', () => {
    const cancelled: AgentSessionEvent = { ...base, seq: 2, type: 'question/cancelled', data: { identity } };
    const [question] = projectQuestions([requested, selected, cancelled]);
    expect(question.status).toBe('cancelled');
    expect(question.answers).toEqual(input.answers);
    expect(pendingUserAction(question)).toBeUndefined();
    expect(projectQuestions(JSON.parse(JSON.stringify([requested, selected, cancelled])))).toEqual([question]);
  });

  it('does not inherit the selected operation when the user supplies another plan', () => {
    const custom: AgentSessionEvent = { ...selected, data: { ...selected.data, submission: {
      ...input, answers: [{ id: 'access', selected: [], custom: 'Use an existing authorized connection' }],
    } } };
    const [question] = projectQuestions([requested, custom]);
    expect(question.status).toBe('answered');
    expect(pendingUserAction(question)).toBeUndefined();
  });
});
