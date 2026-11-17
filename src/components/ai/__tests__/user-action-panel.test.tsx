import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiQuestionHistory, AiQuestionPanel } from '../workspace/ai-question-panel';
import { createQuestionProjection } from '@/lib/ai/question-projection';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useAgentQuestionStore } from '@/stores/agentQuestionStore';
import type { AgentQuestionView, AnswerQuestionInput } from '@/types/agent-question';

const action = { instructions: 'Finish the access configuration outside the Agent.', verification_command: 'test -r /etc/hosts' };
const question: AgentQuestionView = {
  identity: { sessionId: 'workflow', turnId: 'turn', stepId: 'step', requestId: 'request', callId: 'call', questionRequestId: 'question' },
  questions: [{ id: 'access', question: 'Choose access method', multi_select: false,
    options: [{ label: 'Configure access', user_action: action }, { label: 'Another connection' }] }],
  status: 'pending', answers: [{ id: 'access', selected: ['Configure access'] }],
  firstSeq: 0, lastSeq: 1, timestamp: '2026-10-31T00:00:00Z',
};

beforeEach(async () => {
  useAgentQuestionStore.setState({ drafts: {} });
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

describe('user operation within the existing question card', () => {
  it.each(['en-US', 'zh-CN'] as const)('waits for explicit completion without a text field in %s', async locale => {
    await initI18n(locale);
    useAppStore.setState({ locale });
    const submissions: AnswerQuestionInput[] = [];
    const { container } = render(<AiQuestionPanel question={question} onAnswer={async input => { submissions.push(input); }} />);
    expect(submissions).toHaveLength(0);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Choose access method' })).not.toBeInTheDocument();
    expect(screen.getByText(action.instructions)).toBeVisible();
    expect(screen.getByText(action.verification_command)).toBeVisible();
    expect(container.querySelector('.ai-question-panel-header [data-slot="card-action"]')).toBeInTheDocument();
    expect(container.querySelector('.ai-question-panel-content')).toHaveClass('min-h-0', 'overflow-y-auto');
    expect(container.querySelector('.ai-question-panel-footer')).toHaveClass('shrink-0');
    const complete = screen.getByRole('button', { name: locale === 'en-US' ? 'Continue verification' : '继续验证' });
    fireEvent.click(complete);
    expect(screen.getByRole('button', { name: locale === 'en-US' ? 'Saving answers…' : '正在保存答案…' })).toBe(complete);
    expect(complete.querySelector('[data-slot="spinner"]')).toBeVisible();
    expect(complete).toBeDisabled();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ identity: question.identity, answers: question.answers, action: 'completed' });
    await waitFor(() => expect(complete).toBeEnabled());
  });

  it.each([['Cancel', 'cancelled'], ['Change plan', 'change_plan']] as const)('submits %s without changing the committed selection', async (label, response) => {
    const submissions: AnswerQuestionInput[] = [];
    render(<AiQuestionPanel question={question} onAnswer={async input => { submissions.push(input); }} />);
    const button = screen.getByRole('button', { name: label });
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Saving answers…' })).toBe(button);
    expect(button.querySelector('[data-slot="spinner"]')).toBeVisible();
    expect(submissions[0]).toMatchObject({ action: response, answers: question.answers });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it.each([
    {
      locale: 'zh-CN', complete: '继续验证', title: '提问', summary: '1/1 已回答',
      detail: '用户已确认完成，仍需验证结果。',
    },
    {
      locale: 'en-US', complete: 'Continue verification', title: 'Question', summary: '1/1 Answered',
      detail: 'User confirmed completion; verification is required.',
    },
  ] as const)('counts a standalone confirmation in history in $locale', async ({ locale, complete, title, summary, detail }) => {
    await initI18n(locale);
    useAppStore.setState({ locale });
    const projection = createQuestionProjection();
    const event = {
      version: 5, sessionId: question.identity.sessionId, turnId: question.identity.turnId,
      stepId: question.identity.stepId, timeUnixMs: Date.parse(question.timestamp),
    } as const;
    projection.apply({
      ...event, seq: 1, type: 'question/requested', data: {
        identity: question.identity,
        provider: { routeId: 'route', modelId: 'model' },
        arguments: {
          questions: [{ id: 'manual', question: action.instructions, multi_select: false, user_action: action }],
        },
      },
    });

    const submissions: AnswerQuestionInput[] = [];
    const user = userEvent.setup();
    const { rerender } = render(<AiQuestionPanel question={projection.snapshot()[0]}
      onAnswer={async input => { submissions.push(input); }} />);
    await user.click(screen.getByRole('button', { name: complete }));
    expect(submissions).toHaveLength(1);
    expect(submissions[0].answers).toEqual([]);
    expect(submissions[0].action).toBe('completed');

    projection.apply({
      ...event, seq: 2, type: 'question/answered',
      data: { submission: submissions[0], fingerprint: '0'.repeat(64) },
    });
    await act(async () => rerender(<AiQuestionHistory question={projection.snapshot()[0]} />));
    const trigger = screen.getByRole('button', { name: `${title} ${summary}` });
    expect(screen.getByText(summary, { exact: true })).toBeVisible();
    await user.click(trigger);
    expect(screen.getByText(detail, { exact: true })).toBeVisible();
  });
});
