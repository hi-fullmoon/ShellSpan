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
import '@/components/ai/ai-panel.css';

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
      screen.getByRole('button', { name: 'Submit' }),
    ).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'B' }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('alert');
    const original = onAnswer.mock.calls[0][0];
    first.unmount();
    render(<AiQuestionPanel question={question} onAnswer={onAnswer} />);
    await user.click(screen.getByRole('button', { name: 'Submit' }));
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
      await user.click(screen.getByRole('button', { name: 'Submit' }));
      expect(onAnswer.mock.calls[0][0].answers).toEqual([
        { id: 'choice', selected: multi ? ['B'] : [], custom: 'Other' },
      ]);
    },
  );

  it('shows one question at a time and preserves answers across pagination', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <AiQuestionPanel
        question={{
          ...question,
          questions: [
            { ...question.questions[0], header: 'First decision' },
            {
              id: 'second',
              header: 'Second decision',
              question: 'Which follow-up?',
              multi_select: false,
              options: [{ label: 'C' }, { label: 'D' }],
            },
          ],
        }}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getAllByText('First decision')[0]).toBeVisible();
    expect(screen.queryByText('Second decision')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'B' }));
    await user.click(screen.getByRole('button', { name: 'Next question' }));
    expect(screen.getAllByText('Second decision')[0]).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'D' }));
    await user.click(screen.getByRole('button', { name: 'Previous question' }));
    expect(screen.getByRole('button', { name: 'B' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onAnswer.mock.calls[0][0].answers).toEqual([
      { id: 'choice', selected: ['B'] },
      { id: 'second', selected: ['D'] },
    ]);
  });

  it('collapses and restores the active question without losing its draft', async () => {
    const user = userEvent.setup();
    render(<AiQuestionPanel question={question} onAnswer={vi.fn()} />);
    await user.type(screen.getByRole('textbox'), 'Keep this');
    await user.click(screen.getByRole('button', { name: 'Collapse question' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand question' }));
    expect(screen.getByRole('textbox')).toHaveValue('Keep this');
  });

  it('keeps drafts separate across sessions, rejects blank/multibyte overflow and has collapsible read-only history', async () => {
    const user = userEvent.setup();
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
      screen.getByRole('button', { name: 'Submit' }),
    ).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '中'.repeat(2731) },
    });
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    expect(
      screen.getByRole('button', { name: 'Submit' }),
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
    const trigger = screen.getByRole('button', {
      name: 'Question 1/1 Answered',
    });
    expect(trigger).toBeVisible();
    expect(trigger).not.toHaveClass('ai-turn-process-trigger');
    expect(trigger.querySelector('.lucide-message-circle-question-mark')).toBeInTheDocument();
    expect(trigger.querySelector('.ai-disclosure-chevron')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Which approach?')).not.toBeInTheDocument();
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Which approach?')).toBeVisible();
    expect(
      document.querySelector('[data-slot="ai-question-history"]'),
    ).toHaveAttribute('data-variant', 'outline');
    const historyCard = document.querySelector<HTMLElement>(
      '.ai-question-history-card',
    );
    const historyContent = historyCard?.querySelector<HTMLElement>(
      '[data-slot="card-content"]',
    );
    expect(historyCard).toHaveClass('ml-[22px]', 'py-1.5');
    expect(historyContent).toHaveClass('px-2.5');
    expect(historyCard!.querySelector<HTMLElement>('[data-slot="field-set"]')).toHaveClass('gap-1');
    const panel = document.querySelector<HTMLElement>(
      '.ai-question-history > [data-slot="collapsible-content"]',
    );
    expect(getComputedStyle(panel!).height).toBe(
      'var(--collapsible-panel-height)',
    );
    expect(getComputedStyle(panel!).overflow).toBe('hidden');
    expect(getComputedStyle(panel!).transitionProperty).toBe(
      'height, opacity',
    );
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
    expect(screen.queryByText('Submit')).not.toBeInTheDocument();
    expect(screen.getAllByText('What next?')[0]).toBeVisible();
  });
});
