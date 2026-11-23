import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { AiQuestionHistory, AiQuestionPanel } from '../workspace/ai-question-panel';
import { createQuestionProjection } from '@/lib/ai/question-projection';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useAgentQuestionStore } from '@/stores/agentQuestionStore';
import type { AgentQuestionView, AnswerQuestionInput } from '@/types/agent-question';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const action = { instructions: 'Finish the access configuration outside the Agent.', verification_command: 'test -r /etc/hosts' };
const question: AgentQuestionView = {
  identity: { sessionId: 'workflow', turnId: 'turn', stepId: 'step', requestId: 'request', callId: 'call', questionRequestId: 'question' },
  questions: [{ id: 'access', question: 'Choose access method', multi_select: false,
    options: [{ label: 'Configure access', user_action: action }, { label: 'Another connection' }] }],
  status: 'pending', answers: [{ id: 'access', selected: ['Configure access'] }],
  firstSeq: 0, lastSeq: 1, timestamp: '2026-10-31T00:00:00Z',
};

beforeEach(async () => {
  vi.clearAllMocks();
  useAgentQuestionStore.setState({ drafts: {} });
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

describe('user operation within the existing question card', () => {
  it.each(['en-US', 'zh-CN'] as const)('copies commands with local feedback without a header copy button in %s', async locale => {
    await initI18n(locale);
    useAppStore.setState({ locale });
    const user = userEvent.setup();
    const command = "$out='C:\\Users\\example\\home-sizes.csv'; Get-ChildItem | Export-Csv $out";
    const instructions = `Run this command:\n\n\`\`\`powershell\n${command}\n\`\`\`\n\nThen continue verification.`;
    const { container } = render(<AiQuestionPanel question={{ ...question, questions: [{
      id: 'manual', question: 'Run the command', multi_select: false,
      user_action: { ...action, instructions },
    }], answers: [] }} />);
    const headerActions = container.querySelector('.ai-question-panel-actions');
    expect(headerActions?.querySelectorAll('button')).toHaveLength(1);
    const copiedLabel = locale === 'en-US' ? 'Copied' : '已复制';

    const commands = container.querySelectorAll('pre');
    expect(commands).toHaveLength(2);
    for (const [index, expected] of [command, action.verification_command].entries()) {
      const copy = commands[index].closest('[data-ai-copy-region]')!.querySelector('button')!;
      await user.click(copy);
      expect(await navigator.clipboard.readText()).toBe(expected);
      expect(copy).toHaveAccessibleName(copiedLabel);
      expect(copy.querySelector('.lucide-check')).toBeInTheDocument();
    }
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('promotes standalone unfenced and inline-code command lines in instructions to copyable code blocks', async () => {
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
    const user = userEvent.setup();
    const bareCommand = `rm -v /home/yiqishua-0.2.0-x64.exe /home/C54F61A6F9AB41C0A949BED4B1F62A4E.zip; echo "RM_EXIT=$?"; ls /home/ | grep -E 'yiqishua|C54F61A6' || echo BOTH_GONE`;
    const inlineCommand = 'sudo systemctl restart nginx';
    const instructions = [
      '请在绑定的终端（提示符应为 [root@VM-0-3-tencentos ~]#）粘贴执行这一行，并把输出回给我：',
      '',
      bareCommand,
      '',
      `\`${inlineCommand}\``,
      '',
      '判定：',
      '- 输出含两行 removed 且末尾为 BOTH_GONE → 删除成功，我直接出最终报告。',
    ].join('\n');

    const { container } = render(<AiQuestionPanel question={{ ...question, questions: [{
      id: 'manual', question: 'Run the command', multi_select: false,
      user_action: { ...action, instructions },
    }], answers: [] }} />);

    const markdownCodeBlocks = container.querySelectorAll('.ai-markdown-code-block');
    expect(markdownCodeBlocks).toHaveLength(2);

    for (const [index, expected] of [bareCommand, inlineCommand].entries()) {
      const copy = markdownCodeBlocks[index].querySelector('button.ai-markdown-code-copy')!;
      expect(copy).toHaveAccessibleName('复制命令');
      await user.click(copy);
      expect(await navigator.clipboard.readText()).toBe(expected);
      expect(copy).toHaveAccessibleName('已复制');
    }

    expect(screen.getByText('判定：')).toBeVisible();
    expect(container.querySelectorAll('.ai-markdown-code-block')).toHaveLength(2);
  });

  it('reports clipboard failure once without showing success and allows retry', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('locked'));
    render(<AiQuestionPanel question={question} />);
    const copy = screen.getByRole('button', { name: 'Copy command' });
    await user.click(copy);
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Could not copy the command');
    expect(copy).toHaveAccessibleName('Copy command');
    await user.click(copy);
    expect(copy).toHaveAccessibleName('Copied');
    expect(write).toHaveBeenCalledTimes(2);
    expect(toast.success).not.toHaveBeenCalled();
    write.mockRestore();
  });

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
    expect(container.querySelector('[data-slot="ai-question-verification"]')).toHaveClass('shrink-0');
    expect(container.querySelector('.ai-question-panel-content')?.contains(
      container.querySelector('[data-slot="ai-question-verification"]'),
    )).toBe(false);
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

  it('submits Cancel without changing the committed selection', async () => {
    const submissions: AnswerQuestionInput[] = [];
    render(<AiQuestionPanel question={question} onAnswer={async input => { submissions.push(input); }} />);
    const button = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Saving answers…' })).toBe(button);
    expect(button.querySelector('[data-slot="spinner"]')).toBeVisible();
    expect(submissions[0]).toMatchObject({ action: 'cancelled', answers: question.answers });
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('expands an optional non-sensitive note input when changing plan and shows the note in history', async () => {
    const user = userEvent.setup();
    const submissions: AnswerQuestionInput[] = [];
    const { rerender } = render(<AiQuestionPanel question={question} onAnswer={async input => { submissions.push(input); }} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Report issue' }));
    const textbox = screen.getByRole('textbox');
    expect(textbox).toBeVisible();
    await user.type(textbox, 'admin is not in the sudoers file');
    const submit = screen.getByRole('button', { name: 'Submit and adjust plan' });
    await user.click(submit);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      action: 'change_plan',
      actionNote: 'admin is not in the sudoers file',
      answers: question.answers,
    });

    await act(async () => rerender(
      <AiQuestionHistory question={{ ...question, status: 'answered', actionResponse: 'change_plan', actionNote: 'admin is not in the sudoers file' }} />,
    ));
    await user.click(screen.getByRole('button', { name: 'Question 1/1 Answered' }));
    expect(screen.getByText('admin is not in the sudoers file')).toBeVisible();
  });

  it('supports inserting single-line shell commands into the bound terminal', async () => {
    const user = userEvent.setup();
    const inserted: string[] = [];
    const command = 'sudo systemctl restart nginx';
    const multiLine = 'echo first\necho second';
    render(
      <AiQuestionPanel
        question={{
          ...question,
          questions: [{
            id: 'manual',
            question: 'Restart nginx',
            multi_select: false,
            user_action: { ...action, instructions: `\`\`\`sh\n${command}\n\`\`\`\n\n\`\`\`sh\n${multiLine}\n\`\`\`` },
          }],
          answers: [],
        }}
        onInsertToTerminal={(code) => {
          inserted.push(code);
          return true;
        }}
      />,
    );
    const insertButtons = screen.getAllByRole('button', { name: 'Insert into terminal' });
    expect(insertButtons).toHaveLength(1);
    await user.click(insertButtons[0]);
    expect(inserted).toEqual([command]);
    expect(insertButtons[0]).toHaveAccessibleName('Inserted');
  });

  it.each([
    {
      locale: 'zh-CN', complete: '继续验证', title: '手动操作', pending: '等待完成', summary: '已完成',
      detail: '用户已确认完成，仍需验证结果。',
    },
    {
      locale: 'en-US', complete: 'Continue verification', title: 'Manual action', pending: 'Waiting for completion', summary: 'Completed',
      detail: 'User confirmed completion; verification is required.',
    },
  ] as const)('renders standalone manual action status without question counts in $locale', async ({ locale, complete, title, pending, summary, detail }) => {
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
          questions: [{ id: 'manual', question: 'Exit Vim to continue', multi_select: false, user_action: action }],
        },
      },
    });

    const submissions: AnswerQuestionInput[] = [];
    const user = userEvent.setup();
    const { rerender } = render(
      <>
        <AiQuestionHistory question={projection.snapshot()[0]} />
        <AiQuestionPanel question={projection.snapshot()[0]}
          onAnswer={async input => { submissions.push(input); }} />
      </>,
    );
    expect(screen.getByRole('button', { name: `${title} ${pending}` })).toBeVisible();
    expect(screen.getByText('Exit Vim to continue')).toBeVisible();
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
