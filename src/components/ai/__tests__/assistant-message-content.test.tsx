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

    fireEvent.click(screen.getByRole('button', { name: 'common.copy' }));

    expect(writeText).toHaveBeenCalledWith('df -h');
    expect(await screen.findByRole('button', { name: 'common.copied' })).toBeInTheDocument();
  });
});
