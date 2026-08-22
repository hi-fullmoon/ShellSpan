import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SplitPane } from '../split-pane';

let rectSpy: ReturnType<typeof vi.spyOn>;
let originalOffsetWidth: PropertyDescriptor | undefined;
let originalOffsetHeight: PropertyDescriptor | undefined;
let originalOffsetLeft: PropertyDescriptor | undefined;
let originalOffsetTop: PropertyDescriptor | undefined;

beforeEach(() => {
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function mockRect(this: HTMLElement) {
    const isPanel = this.hasAttribute('data-panel');
    const width = isPanel ? 500 : 1000;
    const height = isPanel ? 250 : 500;
    return {
      left: 0,
      top: 0,
      width,
      height,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
  });
  originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  originalOffsetLeft = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft');
  originalOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return this.hasAttribute('data-panel') ? 500 : 1000;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return this.hasAttribute('data-panel') ? 250 : 500;
    },
  });
  const getOffset = function getOffset(this: HTMLElement): number {
    if (this.hasAttribute('data-separator')) return 500;
    if (this.id.endsWith('-second')) return 501;
    return 0;
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetLeft', {
    configurable: true,
    get: getOffset,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get: getOffset,
  });
});

afterEach(() => {
  rectSpy.mockRestore();
  if (originalOffsetWidth) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
  }
  if (originalOffsetHeight) {
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
  }
  if (originalOffsetLeft) {
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', originalOffsetLeft);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'offsetLeft');
  }
  if (originalOffsetTop) {
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', originalOffsetTop);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop');
  }
});

describe('SplitPane', () => {
  it('renders accessible left and right panels', () => {
    render(
      <SplitPane
        left={<div data-testid="left">Left</div>}
        right={<div data-testid="right">Right</div>}
      />,
    );

    expect(screen.getByTestId('left')).toBeInTheDocument();
    expect(screen.getByTestId('right')).toBeInTheDocument();
    const separator = screen.getByRole('separator');
    expect(separator).toHaveAttribute('aria-orientation', 'vertical');
    expect(separator).toHaveAttribute('aria-valuenow', '50');
    expect(separator).toHaveAttribute('tabindex', '0');
    expect(separator).toHaveClass('z-20', 'bg-app-border', 'shadow-none');
    expect(separator).not.toHaveClass('-mt-px');
    expect(screen.getByTestId('left').closest('[data-slot="resizable-panel-group"]'))
      .toHaveClass('isolate');
  });

  it('supports a subtle divider without changing its larger hit target', () => {
    render(
      <SplitPane
        dividerStyle="subtle"
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );

    expect(screen.getByRole('separator')).toHaveClass(
      'bg-app-border/15',
      'after:w-[3px]',
      'hover:after:bg-app-primary',
    );
  });

  it('renders a vertical split with a horizontal separator', () => {
    const { container } = render(
      <SplitPane
        direction="vertical"
        left={<div>Top</div>}
        right={<div>Bottom</div>}
      />,
    );

    expect(container.firstChild).toHaveAttribute('data-direction', 'vertical');
    expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
    expect(screen.getByRole('separator')).toHaveClass(
      '-mt-px',
      'after:w-[3px]',
      'aria-[orientation=horizontal]:after:h-[3px]',
    );
  });

  it('reflects a persisted split ratio in separator aria state', () => {
    render(
      <SplitPane
        split={0.35}
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );

    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '35');
  });

  it('resizes from the keyboard and reports the committed ratio', () => {
    const onSplitChange = vi.fn();
    render(
      <SplitPane
        minWidth={100}
        onSplitChange={onSplitChange}
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );

    const separator = screen.getByRole('separator');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });

    expect(onSplitChange).toHaveBeenCalled();
    expect(onSplitChange.mock.calls[onSplitChange.mock.calls.length - 1]?.[0]).toBeGreaterThan(0.5);
  });

  it('keeps callback and internal state working together when uncontrolled', () => {
    const onSplitChange = vi.fn();
    render(
      <SplitPane
        onSplitChange={onSplitChange}
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );

    const separator = screen.getByRole('separator');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    fireEvent.keyDown(separator, { key: 'ArrowRight' });

    expect(onSplitChange).toHaveBeenCalledTimes(2);
    expect(Number(separator.getAttribute('aria-valuenow'))).toBeGreaterThan(50);
  });
});
