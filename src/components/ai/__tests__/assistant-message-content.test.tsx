import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantMessageContent } from '../assistant-message-content';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
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

  it('rotates the reasoning arrow with the controlled expanded state', () => {
    const { container } = render(
      <AssistantMessageContent
        content="<think>Check the terminal state.</think>Final answer."
        streaming={false}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'ai.thinking' });
    const arrow = container.querySelector('.lucide-chevron-right');

    expect(trigger).not.toHaveClass('-ml-2');
    expect(trigger).toHaveClass('px-2', 'rounded-md');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(arrow).not.toHaveClass('rotate-90');

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(arrow).toHaveClass('rotate-90');

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(arrow).not.toHaveClass('rotate-90');
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
