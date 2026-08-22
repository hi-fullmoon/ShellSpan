import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Message, MessageScroller } from '../chat-primitives';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

describe('MessageScroller', () => {
  it('uses the shared ScrollArea viewport for the conversation', async () => {
    const { container } = render(
      <MessageScroller followKey="1" ariaLabel="Conversation">
        <Message role="assistant">Response</Message>
      </MessageScroller>,
    );

    const scrollArea = container.querySelector('[data-slot="scroll-area"]');
    const viewport = scrollArea?.querySelector('[data-slot="scroll-area-viewport"]');

    await waitFor(() => {
      expect(scrollArea).toBeInTheDocument();
      expect(viewport).toBeInTheDocument();
      expect(viewport?.querySelector('[data-slot="message-scroller-content"]')).toBeInTheDocument();
    });
  });
});
