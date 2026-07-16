import { describe, expect, it, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { act } from 'react';
import { PathBreadcrumb } from '../path-breadcrumb';

let resizeCallback: ResizeObserverCallback | null = null;
let originalResizeObserver: typeof window.ResizeObserver | undefined;

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

beforeAll(() => {
  originalResizeObserver = window.ResizeObserver;
  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: ResizeObserverMock,
  });
});

afterAll(() => {
  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: originalResizeObserver,
  });
});

afterEach(() => {
  resizeCallback = null;
});

describe('PathBreadcrumb', () => {
  it('renders / for root path', () => {
    render(<PathBreadcrumb path="/" onNavigate={vi.fn()} />);
    expect(screen.getByRole('button', { name: '/' })).toBeInTheDocument();
  });

  it('renders root segment as / for nested paths', () => {
    const onNavigate = vi.fn();
    render(<PathBreadcrumb path="/home/user" onNavigate={onNavigate} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toHaveTextContent('/');
    fireEvent.click(buttons[0]);
    expect(onNavigate).toHaveBeenCalledWith('/');
  });

  it('limits each segment width to 200px', () => {
    render(<PathBreadcrumb path="/very/long/segment/name" onNavigate={vi.fn()} />);
    const spans = screen.getAllByText(/very|long|segment|name/);
    spans.forEach((span) => {
      expect(span).toHaveClass('max-w-[200px]');
    });
  });

  it('collapses to root, ellipsis, and last segment in a narrow container', () => {
    const path = '/a/b/c/d/e/f/g/h/i/j';
    const { container } = render(<PathBreadcrumb path={path} onNavigate={vi.fn()} />);
    const div = container.firstChild as HTMLDivElement;

    Object.defineProperty(div, 'scrollWidth', { value: 1000, configurable: true });
    Object.defineProperty(div, 'clientWidth', { value: 100, configurable: true });

    act(() => {
      resizeCallback?.(
        [{ contentRect: { width: 100 } } as unknown as ResizeObserverEntry],
        new ResizeObserverMock(resizeCallback),
      );
    });

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toHaveTextContent('/');
    expect(buttons[1]).toHaveTextContent('...');
    expect(buttons[2]).toHaveTextContent('j');
    expect(screen.queryByRole('button', { name: 'a' })).not.toBeInTheDocument();
  });
});
