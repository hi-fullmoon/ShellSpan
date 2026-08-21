import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResponsiveCardGrid } from '../responsive-card-grid';

describe('ResponsiveCardGrid', () => {
  let resizeObserverCallback: ResizeObserverCallback | undefined;

  class ResizeObserverMock {
    constructor(callback: ResizeObserverCallback) {
      resizeObserverCallback = callback;
    }

    observe() {}

    unobserve() {}

    disconnect() {}
  }

  const resizeContainerTo = (width: number) => {
    if (!resizeObserverCallback) {
      throw new Error('ResizeObserver callback is not registered');
    }

    act(() => {
      resizeObserverCallback!(
        [
          {
            contentRect: {
              width,
              height: 0,
              x: 0,
              y: 0,
              top: 0,
              right: width,
              bottom: 0,
              left: 0,
              toJSON: () => ({}),
            },
          } as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    });
  };

  beforeEach(() => {
    resizeObserverCallback = undefined;
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    });
  });

  it('uses the default 3, 4 and 5 column layout', () => {
    render(
      <ResponsiveCardGrid>
        <div>Card</div>
      </ResponsiveCardGrid>,
    );

    const grid = screen.getByText('Card').parentElement;
    expect(grid).toHaveStyle({ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' });

    resizeContainerTo(900);
    expect(grid).toHaveStyle({ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' });

    resizeContainerTo(1200);
    expect(grid).toHaveStyle({
      gap: '0.5rem',
      gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
    });
  });

  it('sorts and applies custom breakpoints', () => {
    render(
      <ResponsiveCardGrid
        columns={1}
        breakpoints={[
          { minWidth: 1000, columns: 4 },
          { minWidth: 600, columns: 2 },
        ]}
        gap={16}
      >
        <div>Card</div>
      </ResponsiveCardGrid>,
    );

    const grid = screen.getByText('Card').parentElement;
    resizeContainerTo(700);
    expect(grid).toHaveStyle({
      gap: '16px',
      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    });

    resizeContainerTo(1000);
    expect(grid).toHaveStyle({ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' });
  });

  it('preserves empty tracks so incomplete rows keep the full-row card width', () => {
    render(
      <ResponsiveCardGrid minColumnWidth="22rem" gap="0.375rem">
        <div>Card</div>
      </ResponsiveCardGrid>,
    );

    const grid = screen.getByText('Card').parentElement;
    expect(grid).toHaveStyle({
      gap: '0.375rem',
      gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 22rem), 1fr))',
    });
  });
});
