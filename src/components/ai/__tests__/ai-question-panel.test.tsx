import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiQuestionPanel,
  AiQuestionHistory,
} from '../workspace/ai-question-panel';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useAgentQuestionStore } from '@/stores/agentQuestionStore';
import type { AgentQuestionView } from '@/types/agent-question';

const question: AgentQuestionView = {
  identity: {
    sessionId: 'session',
    turnId: 'turn',
    stepId: 'step',
    requestId: 'request',
    callId: 'call',
    questionRequestId: 'question',
  },
  questions: [
    {
      id: 'choice',
      question: 'Which approach?',
      multi_select: false,
      options: [
        { label: 'A (Recommended)', description: 'First option' },
        { label: 'B' },
      ],
    },
  ],
  status: 'pending',
  answers: [],
  firstSeq: 1,
  lastSeq: 1,
  timestamp: '2026-09-04T00:00:00Z',
};
beforeEach(async () => {
  useAgentQuestionStore.setState({ drafts: {} });
  useAppStore.setState({ locale: 'en-US' });
  await initI18n('en-US');
});
afterEach(cleanup);

describe('Stage 6A question form', () => {
  it('never auto-selects recommendations; failed IPC retries identical operation and payload after remount', async () => {
    const user = userEvent.setup();
    const onAnswer = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValue(undefined);
    const first = render(
      <AiQuestionPanel question={question} onAnswer={onAnswer} />,
    );
    expect(
      screen.getByRole('button', { name: 'Submit answers' }),
    ).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'B' }));
    await user.click(screen.getByRole('button', { name: 'Submit answers' }));
    await screen.findByRole('alert');
    const original = onAnswer.mock.calls[0][0];
    first.unmount();
    render(<AiQuestionPanel question={question} onAnswer={onAnswer} />);
    await user.click(screen.getByRole('button', { name: 'Submit answers' }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(2));
    expect(onAnswer.mock.calls[1][0]).toEqual(original);
    expect(original.answers).toEqual([{ id: 'choice', selected: ['B'] }]);
  });

  it.each([false, true])(
    'custom input has correct single/multi semantics (%s)',
    async (multi) => {
      const onAnswer = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(
        <AiQuestionPanel
          question={{
            ...question,
            questions: [{ ...question.questions[0], multi_select: multi }],
          }}
          onAnswer={onAnswer}
        />,
      );
      await user.click(screen.getByRole('button', { name: 'B' }));
      await user.type(screen.getByRole('textbox'), 'Other');
      await user.click(screen.getByRole('button', { name: 'Submit answers' }));
      expect(onAnswer.mock.calls[0][0].answers).toEqual([
        { id: 'choice', selected: multi ? ['B'] : [], custom: 'Other' },
      ]);
    },
  );

  it('keeps drafts separate across sessions, rejects blank/multibyte overflow and has read-only history', () => {
    const first = render(
      <AiQuestionPanel question={question} onAnswer={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'saved draft' },
    });
    first.unmount();
    const second = render(
      <AiQuestionPanel
        question={{
          ...question,
          identity: { ...question.identity, sessionId: 'other' },
        }}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByRole('textbox')).toHaveValue('');
    second.unmount();
    const restored = render(
      <AiQuestionPanel question={question} onAnswer={vi.fn()} />,
    );
    expect(screen.getByRole('textbox')).toHaveValue('saved draft');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
    expect(
      screen.getByRole('button', { name: 'Submit answers' }),
    ).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '中'.repeat(2731) },
    });
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    expect(
      screen.getByRole('button', { name: 'Submit answers' }),
    ).toBeDisabled();
    restored.unmount();
    render(
      <AiQuestionHistory
        question={{
          ...question,
          status: 'answered',
          answers: [{ id: 'choice', selected: ['B'] }],
        }}
      />,
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Answered')).toBeVisible();
  });

  it('supports free-text-only questions and Chinese chrome', async () => {
    await initI18n('zh-CN');
    useAppStore.setState({ locale: 'zh-CN' });
    render(
      <AiQuestionPanel
        question={{
          ...question,
          questions: [
            { id: 'text', question: 'What next?', multi_select: false },
          ],
        }}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getByRole('textbox')).toBeVisible();
    expect(screen.queryByText('Submit answers')).not.toBeInTheDocument();
    expect(screen.getByText('What next?')).toBeVisible();
  });
});
