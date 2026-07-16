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

  it('normalizes a Windows path entered for local navigation', () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <PathBreadcrumb
        path="C:/Users/tester"
        onNavigate={onNavigate}
        normalizeInputPath
      />,
    );

    fireEvent.doubleClick(container.firstChild as HTMLElement);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'D:\\Games\\Warcraft3_1.24E' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onNavigate).toHaveBeenCalledWith('D:/Games/Warcraft3_1.24E');
  });

  it('preserves backslashes entered for remote navigation', () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <PathBreadcrumb path="/home/tester" onNavigate={onNavigate} />,
    );

    fireEvent.doubleClick(container.firstChild as HTMLElement);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '/home/name\\with\\slashes' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onNavigate).toHaveBeenCalledWith('/home/name\\with\\slashes');
  });

  it('matches the input line height to the displayed breadcrumb text', () => {
    const { container } = render(
      <PathBreadcrumb path="/home/tester" onNavigate={vi.fn()} />,
    );

    fireEvent.doubleClick(container.firstChild as HTMLElement);

    expect(screen.getByRole('textbox')).toHaveClass('leading-none');
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

  it('does not oscillate between collapsed and expanded content', () => {
    const path = '/a/b/c/d/e/f/g/h/i/j';
    const { container } = render(<PathBreadcrumb path={path} onNavigate={vi.fn()} />);
    const div = container.firstChild as HTMLDivElement;

    Object.defineProperty(div, 'scrollWidth', {
      configurable: true,
      get: () => (screen.getAllByRole('button').length > 3 ? 1000 : 100),
    });
    Object.defineProperty(div, 'clientWidth', { value: 160, configurable: true });

    const buttonCounts: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      act(() => {
        resizeCallback?.(
          [{ contentRect: { width: 160 } } as unknown as ResizeObserverEntry],
          new ResizeObserverMock(resizeCallback),
        );
      });
      buttonCounts.push(screen.getAllByRole('button').length);
    }

    expect(new Set(buttonCounts).size).toBe(1);
    expect(buttonCounts[0]).toBe(3);
  });

  it('uses measured button widths before collapsing', () => {
    const path = '/a/b/c/d';
    const { container } = render(<PathBreadcrumb path={path} onNavigate={vi.fn()} />);
    const measurement = container.querySelector<HTMLElement>(
      '[data-breadcrumb-measurement]',
    )!;
    const root = measurement.querySelector<HTMLElement>('[data-breadcrumb-root]')!;
    const ellipsis = measurement.querySelector<HTMLElement>(
      '[data-breadcrumb-ellipsis]',
    )!;
    const chevron = measurement.querySelector<SVGElement>('svg')!;
    const segments = measurement.querySelectorAll<HTMLElement>(
      '[data-breadcrumb-segment]',
    );

    root.getBoundingClientRect = () => ({ width: 24 }) as DOMRect;
    ellipsis.getBoundingClientRect = () => ({ width: 24 }) as DOMRect;
    chevron.getBoundingClientRect = () => ({ width: 12 }) as DOMRect;
    segments.forEach((segment) => {
      segment.getBoundingClientRect = () => ({ width: 32 }) as DOMRect;
    });

    act(() => {
      resizeCallback?.(
        [{ contentRect: { width: 250 } } as unknown as ResizeObserverEntry],
        new ResizeObserverMock(resizeCallback),
      );
    });

    expect(screen.getAllByRole('button')).toHaveLength(5);
    expect(screen.queryByRole('button', { name: '...' })).not.toBeInTheDocument();
  });
});
