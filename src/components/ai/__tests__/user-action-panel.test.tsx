import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AiQuestionPanel } from '../workspace/ai-question-panel';
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
    const user = userEvent.setup();
    const { container } = render(<AiQuestionPanel question={question} onAnswer={async input => { submissions.push(input); }} />);
    expect(submissions).toHaveLength(0);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Choose access method' })).not.toBeInTheDocument();
    expect(screen.getByText(action.instructions)).toBeVisible();
    expect(screen.getByText(action.verification_command)).toBeVisible();
    expect(container.querySelector('.ai-question-panel-header [data-slot="card-action"]')).toBeInTheDocument();
    expect(container.querySelector('.ai-question-panel-content')).toHaveClass('min-h-0', 'overflow-y-auto');
    expect(container.querySelector('.ai-question-panel-footer')).toHaveClass('shrink-0');
    await user.click(screen.getByRole('button', { name: locale === 'en-US' ? 'I have completed it' : '我已完成操作' }));
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ identity: question.identity, answers: question.answers, action: 'completed' });
  });

  it.each([['Cancel', 'cancelled'], ['Change plan', 'change_plan']] as const)('submits %s without changing the committed selection', async (label, response) => {
    const submissions: AnswerQuestionInput[] = [];
    render(<AiQuestionPanel question={question} onAnswer={async input => { submissions.push(input); }} />);
    await userEvent.setup().click(screen.getByRole('button', { name: label }));
    expect(submissions[0]).toMatchObject({ action: response, answers: question.answers });
  });

  it('submits standalone completion with no question text or credentials', async () => {
    const submissions: AnswerQuestionInput[] = [];
    render(<AiQuestionPanel question={{ ...question, answers: [], questions: [
      { id: 'manual', question: action.instructions, multi_select: false, user_action: action },
    ] }} onAnswer={async input => { submissions.push(input); }} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'I have completed it' }));
    expect(submissions[0].answers).toEqual([]);
    expect(submissions[0].action).toBe('completed');
  });
});
