import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantMessageContent } from '../assistant-message-content';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) => (
      variables ? `${key}:${variables.seconds}` : key
    ),
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

describe('AssistantMessageContent', () => {
  it('expands reasoning when thinking content starts streaming', async () => {
    const { rerender } = render(
      <AssistantMessageContent content="" streaming />,
    );

    expect(screen.queryByRole('button', { name: 'ai.thinking.inProgress' })).not.toBeInTheDocument();

    rerender(
      <AssistantMessageContent content="<think>Check the terminal state." streaming />,
    );

    const trigger = await screen.findByRole('button', { name: 'ai.thinking.inProgress' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelector('.ai-reasoning-body')).toHaveTextContent('Check the terminal state.');
  });

  it('keeps the compact reasoning disclosure semantic while expanding and collapsing', () => {
    const { container } = render(
      <AssistantMessageContent
        content="<think>Check the terminal state.</think>Final answer."
        streaming={false}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'ai.thinking' });
    const arrow = container.querySelector('.ai-disclosure-chevron');
    const brain = container.querySelector('.lucide-brain');
    const row = container.querySelector('.ai-reasoning-row');

    expect(trigger).toHaveClass('ai-disclosure-row');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(brain).toBeInTheDocument();
    expect(trigger.lastElementChild).toBe(arrow);
    expect(row).not.toHaveAttribute('data-expanded');
    expect(container.querySelector('.ai-reasoning-body')).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(row).toHaveAttribute('data-expanded');
    expect(container.querySelector('.ai-reasoning-body')).toHaveTextContent('Check the terminal state.');

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(row).not.toHaveAttribute('data-expanded');
    expect(container.querySelector('.ai-reasoning-body')).not.toBeInTheDocument();
  });

  it('shows the elapsed thinking time after reasoning completes', async () => {
    let now = new Date('2026-08-30T00:00:00Z').getTime();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      const { rerender } = render(
        <AssistantMessageContent content="" streaming />,
      );
      now += 2_100;

      rerender(
        <AssistantMessageContent
          content="<think>Check the terminal state.</think>Final answer."
          streaming={false}
        />,
      );

      expect(await screen.findByRole('button', {
        name: 'ai.thinking.completed:3',
      })).toBeInTheDocument();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('copies fenced code blocks', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(
      <AssistantMessageContent
        content={'Run:\n```bash\ndf -h\n```'}
        streaming={false}
      />,
    );

    const copyButton = screen.getByRole('button', { name: 'common.copy' });
    expect(copyButton).toHaveClass('ai-code-block-copy');
    expect(copyButton.closest('.ai-code-block')).toHaveAttribute('data-language', 'bash');

    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith('df -h');
    const copiedButton = await screen.findByRole('button', { name: 'common.copied' });
    expect(copiedButton).toHaveTextContent('common.copied');
  });

  it('renders fenced code blocks without actions when disabled', () => {
    render(
      <AssistantMessageContent
        content={'Review:\n```bash\ndf -h\n```'}
        streaming={false}
        showCodeBlockActions={false}
      />,
    );

    expect(screen.getByText('df -h')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'common.copy' })).not.toBeInTheDocument();
  });

  it('renders Markdown while streaming', () => {
    const content = '## Run\n\n```bash\ndf -h\n```';
    render(
      <AssistantMessageContent content={content} streaming />,
    );

    expect(screen.getByRole('heading', { name: 'Run' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.copy' })).toBeInTheDocument();
    expect(screen.queryByText(/```bash/)).not.toBeInTheDocument();
  });

  it('preserves a large loose list across streaming render chunks', () => {
    const content = `${Array.from(
      { length: 120 },
      (_, index) => `${index + 1}. Item ${index + 1}\n\n`,
    ).join('')}After the list.\n`;
    const { container } = render(
      <AssistantMessageContent content={content} streaming />,
    );

    expect(container.querySelectorAll('ol')).toHaveLength(1);
    expect(screen.getAllByRole('listitem')).toHaveLength(120);
    expect(screen.getByText('After the list.')).toBeInTheDocument();
  });
});
