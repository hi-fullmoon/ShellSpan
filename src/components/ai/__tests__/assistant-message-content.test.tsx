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
    expect(screen.getByText('Check the terminal state.')).toBeVisible();
  });

  it('places the reasoning arrow after the status and rotates it with the expanded state', () => {
    const { container } = render(
      <AssistantMessageContent
        content="<think>Check the terminal state.</think>Final answer."
        streaming={false}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'ai.thinking' });
    const arrow = container.querySelector('.lucide-chevron-right');
    const atom = container.querySelector('.lucide-atom');

    expect(trigger).not.toHaveClass('-ml-2');
    expect(trigger).toHaveClass('bg-transparent', 'px-0', 'rounded-md', 'leading-none');
    expect(trigger).not.toHaveClass('px-2', 'hover:bg-accent', 'hover:text-accent-foreground');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(atom).toHaveClass('text-primary');
    expect(trigger.lastElementChild).toBe(arrow);
    expect(arrow).not.toHaveClass('rotate-90');

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(arrow).toHaveClass('rotate-90');

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(arrow).not.toHaveClass('rotate-90');
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
    expect(copyButton).toHaveClass('size-6', 'p-0', 'opacity-0');
    expect(copyButton).toHaveClass(
      'group-hover/code-block:opacity-100',
      'group-focus-within/code-block:opacity-100',
    );

    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith('df -h');
    const copiedButton = await screen.findByRole('button', { name: 'common.copied' });
    expect(copiedButton).not.toHaveClass('opacity-0');
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
