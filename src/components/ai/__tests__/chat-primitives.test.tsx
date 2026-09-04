import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Message, MessageScroller } from '../chat-primitives';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

describe('MessageScroller', () => {
  it('composes ScrollArea with the message scroller viewport as the sole scroll owner', async () => {
    const { container } = render(
      <MessageScroller followKey="1" contentClassName="gap-2 px-3 py-3" ariaLabel="Conversation">
        <Message role="assistant">Response</Message>
      </MessageScroller>,
    );

    const scrollArea = container.querySelector('[data-slot="scroll-area"]');
    const viewport = scrollArea?.querySelector(
      '[data-slot="scroll-area-viewport"][data-message-scroller-viewport]',
    );

    await waitFor(() => {
      expect(scrollArea).toBeInTheDocument();
      expect(viewport).toBeInTheDocument();
      expect(viewport).toHaveAttribute('role', 'region');
      const content = viewport?.querySelector('[data-slot="message-scroller-content"]');
      expect(content).toBeInTheDocument();
      expect(content).toHaveClass('gap-2', 'px-3', 'py-3');
      expect(content).not.toHaveClass('gap-5', 'px-4', 'py-5');
      expect(viewport).toHaveStyle({ overflow: 'scroll' });
      expect(viewport).not.toHaveClass('overflow-y-auto');
      expect(container.querySelector('[data-slot="message-scroller-button"]'))
        .toHaveClass('rounded-full');
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
      expect(container.querySelector('[data-slot="message-scroller-content"]'))
        .toHaveClass('gap-4', 'px-3', 'py-4');
    });
  });

  it.each(['wheel', 'scrollbar'])('follows at the live edge, detaches on %s input, and jumps back to latest', async (input) => {
    let itemCount = 3;
    const thread = () => (
      <MessageScroller followKey={String(itemCount)} ariaLabel="Conversation">
        {Array.from({ length: itemCount }, (_, index) => (
          <Message key={`message-${index}`} role="assistant">
            Message {index}
          </Message>
        ))}
      </MessageScroller>
    );
    const { container, rerender } = render(thread());
    const viewport = container.querySelector<HTMLElement>('[data-message-scroller-viewport]');
    if (!viewport) throw new Error('MessageScroller viewport is unavailable');
    let scrollTop = 200;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => itemCount * 100 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
      scrollTo: {
        configurable: true,
        value: vi.fn(({ top }: ScrollToOptions) => { scrollTop = Number(top ?? 0); }),
      },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          bottom: 100,
          height: 100,
          left: 0,
          right: 320,
          top: 0,
          width: 320,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }),
      },
    });
    const scrollTo = vi.mocked(viewport.scrollTo);
    const installItemRects = (): void => {
      const items = container.querySelectorAll<HTMLElement>('[data-slot="message-scroller-item"]');
      items.forEach((item, index) => {
        Object.defineProperty(item, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({
            bottom: (index + 1) * 100 - scrollTop,
            height: 100,
            left: 0,
            right: 320,
            top: index * 100 - scrollTop,
            width: 320,
            x: 0,
            y: index * 100 - scrollTop,
            toJSON: () => ({}),
          }),
        });
      });
    };
    installItemRects();
    fireEvent.scroll(viewport);
    scrollTo.mockClear();

    itemCount = 4;
    rerender(thread());
    await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    expect(scrollTop).toBe(300);

    installItemRects();
    scrollTo.mockClear();
    scrollTop = 100;
    if (input === 'scrollbar') {
      // jsdom has no overflow layout, so Base UI does not mount its scrollbar.
      const scrollbar = document.createElement('div');
      scrollbar.dataset.slot = 'scroll-area-scrollbar';
      container.querySelector('[data-slot="scroll-area"]')!.appendChild(scrollbar);
      fireEvent.pointerDown(scrollbar);
      scrollbar.remove();
    } else {
      fireEvent.wheel(viewport, { deltaY: -100 });
    }
    fireEvent.scroll(viewport);
    const jump = container.querySelector<HTMLButtonElement>('[data-slot="message-scroller-button"]');
    await waitFor(() => expect(jump).toHaveAttribute('data-active', 'true'));

    itemCount = 5;
    rerender(thread());
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(scrollTo).not.toHaveBeenCalled();

    fireEvent.click(jump!);
    expect(scrollTo).toHaveBeenCalledWith({ behavior: 'smooth', top: 400 });
  });

  it('keeps the first visible node anchored when older rows are prepended', async () => {
    let keys = ['node-0', 'node-1', 'node-2'];
    const saved = vi.fn();
    const thread = () => (
      <MessageScroller followKey={keys.join(':')} ariaLabel="Conversation" onAnchorChange={saved}>
        {keys.map((key) => <div key={key} data-ai-node-key={key}>{key}</div>)}
      </MessageScroller>
    );
    const { container, rerender } = render(thread());
    const viewport = container.querySelector<HTMLElement>('[data-message-scroller-viewport]');
    if (!viewport) throw new Error('MessageScroller viewport is unavailable');
    let scrollTop = 100;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => keys.length * 100 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, bottom: 100, height: 100, left: 0, right: 320, width: 320, x: 0, y: 0, toJSON: () => ({}) }),
      },
    });
    const installRects = (): void => {
      container.querySelectorAll<HTMLElement>('[data-ai-node-key]').forEach((row) => {
        Object.defineProperty(row.parentElement!, 'getBoundingClientRect', {
          configurable: true,
          value: () => {
            const index = keys.indexOf(row.dataset.aiNodeKey ?? '');
            return ({
            top: index * 100 - scrollTop,
            bottom: (index + 1) * 100 - scrollTop,
            height: 100,
            left: 0,
            right: 320,
            width: 320,
            x: 0,
            y: index * 100 - scrollTop,
            toJSON: () => ({}),
          });
          },
        });
      });
    };
    installRects();
    fireEvent.scroll(viewport);
    expect(saved).toHaveBeenLastCalledWith({ nodeKey: 'node-1', offset: 0, scrollTop: 100 });

    keys = ['older', ...keys];
    rerender(thread());
    installRects();
    rerender(thread());
    await waitFor(() => expect(scrollTop).toBe(200));
  });

  it('saves the visible row without forcing layout inside offscreen messages', () => {
    const saved = vi.fn();
    const { container } = render(
      <MessageScroller followKey="long-thread" onAnchorChange={saved}>
        {Array.from({ length: 256 }, (_, index) => (
          <div key={index} data-ai-node-key={`node-${index}`}>Message {index}</div>
        ))}
      </MessageScroller>,
    );
    const viewport = container.querySelector<HTMLElement>('[data-message-scroller-viewport]')!;
    const rect = (top: number) => ({ top, bottom: top + 100, height: 100, left: 0, right: 320, width: 320, x: 0, y: top, toJSON: () => ({}) });
    Object.defineProperties(viewport, {
      scrollTop: { configurable: true, value: 25_050, writable: true },
      scrollHeight: { configurable: true, value: 25_600 },
      clientHeight: { configurable: true, value: 100 },
      getBoundingClientRect: { configurable: true, value: () => rect(0) },
    });
    const measureMessage = vi.fn(() => rect(0));
    container.querySelectorAll<HTMLElement>('[data-ai-node-key]').forEach((node, index) => {
      node.getBoundingClientRect = measureMessage;
      node.parentElement!.getBoundingClientRect = () => rect(index * 100 - viewport.scrollTop);
    });

    fireEvent.scroll(viewport);

    expect(saved).toHaveBeenLastCalledWith({ nodeKey: 'node-250', offset: -50, scrollTop: 25_050 });
    expect(measureMessage).not.toHaveBeenCalled();
  });

  it('does not replay saved scroll positions when the parent updates during reading', async () => {
    const children = <div data-ai-node-key="node-1">A long response</div>;
    const { container, rerender } = render(<MessageScroller followKey="1">{children}</MessageScroller>);
    const viewport = container.querySelector<HTMLElement>('[data-message-scroller-viewport]')!;
    const scrollTo = vi.fn();
    Object.defineProperties(viewport, {
      scrollTop: { configurable: true, value: 120, writable: true },
      scrollTo: { configurable: true, value: scrollTo },
    });

    rerender(
      <MessageScroller followKey="2" initialAnchor={{ nodeKey: 'node-1', offset: -20, scrollTop: 120 }}>
        {children}
      </MessageScroller>,
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(viewport.scrollTop).toBe(120);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
