import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SplitPane } from '../split-pane';

describe('SplitPane', () => {
  it('renders left and right content', () => {
    const { container } = render(
      <SplitPane
        left={<div data-testid="left">Left</div>}
        right={<div data-testid="right">Right</div>}
      />,
    );
    expect(screen.getByTestId('left')).toBeInTheDocument();
    expect(screen.getByTestId('right')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="split-pane-divider"]')).toHaveClass(
      'border-l',
      'border-app-border',
      'shadow-none',
    );
    expect(container.querySelector('[data-slot="split-pane-handle"]')).toHaveClass(
      'w-[3px]',
      'bg-transparent',
      'shadow-none',
    );
    expect(
      container.querySelector('[data-slot="split-pane-indicator"]'),
    ).toHaveClass('w-px', 'bg-transparent', 'shadow-none');
  });

  it('supports a subtle horizontal divider without changing the default style', () => {
    const { container } = render(
      <SplitPane
        dividerStyle="subtle"
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );

    expect(container.querySelector('[data-slot="split-pane-divider"]')).toHaveClass(
      'border-l-[0.5px]',
      'border-app-border/15',
    );
  });

  it('renders a vertical split with a horizontal divider', () => {
    const { container } = render(
      <SplitPane
        direction="vertical"
        left={<div>Top</div>}
        right={<div>Bottom</div>}
      />,
    );

    expect(container.firstChild).toHaveAttribute('data-direction', 'vertical');
    expect(container.firstChild).toHaveClass('flex-col');
    expect(container.querySelector('[data-slot="split-pane-divider"]')).toHaveClass('border-t');
    expect(container.querySelector('[data-slot="split-pane-handle"]')).toHaveClass('cursor-row-resize');
  });

  it('matches the subtle horizontal style for vertical dividers', () => {
    const { container } = render(
      <SplitPane
        direction="vertical"
        dividerStyle="subtle"
        left={<div>Top</div>}
        right={<div>Bottom</div>}
      />,
    );

    expect(container.querySelector('[data-slot="split-pane-divider"]')).toHaveClass(
      'border-t-[0.5px]',
      'border-app-border/15',
    );
    expect(container.querySelector('[data-slot="split-pane-indicator"]')).toHaveClass(
      'h-px',
      'group-hover:h-0.5',
      'group-hover:bg-app-primary/80',
    );
  });

  it('disables text selection while dragging and restores it afterwards', () => {
    const { container } = render(
      <SplitPane left={<div>Left</div>} right={<div>Right</div>} />,
    );
    const handle = container.querySelector('[data-slot="split-pane-handle"]')!;

    fireEvent.mouseDown(handle);
    expect(document.body.style.userSelect).toBe('none');
    expect(document.body.style.cursor).toBe('col-resize');

    fireEvent.mouseUp(document);
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('restores global styles when unmounted mid-drag', () => {
    const { container, unmount } = render(
      <SplitPane left={<div>Left</div>} right={<div>Right</div>} />,
    );
    const handle = container.querySelector('[data-slot="split-pane-handle"]')!;

    fireEvent.mouseDown(handle);
    unmount();
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');
  });

  it('coalesces drag updates to one split change per animation frame', () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const onSplitChange = vi.fn();
    try {
      const { container } = render(
        <SplitPane
          left={<div>Left</div>}
          right={<div>Right</div>}
          minWidth={100}
          onSplitChange={onSplitChange}
        />,
      );
      const root = container.firstElementChild as HTMLElement;
      vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        top: 0,
        width: 1000,
        height: 500,
        right: 1000,
        bottom: 500,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      const handle = container.querySelector('[data-slot="split-pane-handle"]')!;

      fireEvent.mouseDown(handle);
      fireEvent.mouseMove(document, { clientX: 300, clientY: 0 });
      fireEvent.mouseMove(document, { clientX: 700, clientY: 0 });

      expect(frames).toHaveLength(1);
      expect(onSplitChange).not.toHaveBeenCalled();
      act(() => frames[0](0));
      expect(onSplitChange).toHaveBeenCalledTimes(1);
      expect(onSplitChange).toHaveBeenCalledWith(0.7);
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });
});
