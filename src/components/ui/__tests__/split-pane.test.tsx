import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
});
