import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Message, MessageScroller } from '../chat-primitives';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

describe('MessageScroller', () => {
  it('uses the message scroller viewport as the sole scroll owner', async () => {
    const { container } = render(
      <MessageScroller followKey="1" contentClassName="gap-2 px-3 py-3" ariaLabel="Conversation">
        <Message role="assistant">Response</Message>
      </MessageScroller>,
    );

    const scrollArea = container.querySelector('[data-slot="scroll-area"]');
    const viewport = container.querySelector(
      '[data-slot="message-scroller"] > [data-slot="message-scroller-viewport"]',
    );

    await waitFor(() => {
      expect(scrollArea).not.toBeInTheDocument();
      expect(viewport).toBeInTheDocument();
      const content = viewport?.querySelector('[data-slot="message-scroller-content"]');
      expect(content).toBeInTheDocument();
      expect(content).toHaveClass('gap-2', 'px-3', 'py-3');
      expect(content).not.toHaveClass('gap-5', 'px-4', 'py-5');
      expect(viewport).toHaveClass('overflow-y-auto');
    });
  });

  it('does not allocate spacing for empty conditional children', async () => {
    const { container } = render(
      <MessageScroller followKey="1" ariaLabel="Conversation">
        <div>First card</div>
        {false && <div>Hidden card</div>}
        <div>Second card</div>
      </MessageScroller>,
    );

    await waitFor(() => {
      expect(container.querySelectorAll('[data-slot="message-scroller-item"]')).toHaveLength(2);
    });
  });
});
