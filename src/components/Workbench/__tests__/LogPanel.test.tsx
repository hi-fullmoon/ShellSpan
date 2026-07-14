import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogPanel } from '../LogPanel';

const loadFiles = vi.fn().mockResolvedValue(undefined);
const loadFile = vi.fn().mockResolvedValue(undefined);
const refreshActiveFile = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) =>
      variables?.count === undefined ? key : `${key}:${variables.count}`,
  }),
}));

vi.mock('@/stores/logStore', () => ({
  useLogStore: () => ({
    files: [],
    activeFileName: 'termbridge.log',
    content:
      'first complete log line\nsecond complete log line\nthird complete log line',
    loading: false,
    loadFiles,
    loadFile,
    refreshActiveFile,
  }),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 18,
      })),
    getTotalSize: () => count * 18,
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  }),
}));

describe('LogPanel', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('copies one complete raw log line on a single click', async () => {
    vi.useFakeTimers();
    render(<LogPanel />);

    fireEvent.click(screen.getByText('second complete log line'));
    expect(writeText).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith('second complete log line');
  });

  it('cancels pending single-click copying when a row is double-clicked', async () => {
    vi.useFakeTimers();
    render(<LogPanel />);

    const firstLine = screen.getByText('first complete log line');
    fireEvent.click(firstLine);
    fireEvent.doubleClick(firstLine);

    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });

    expect(writeText).not.toHaveBeenCalled();
    expect(
      screen.getByText('workbench.logs.selectedCount:1'),
    ).toBeInTheDocument();
  });

  it('selects log rows and copies their complete raw content in order', async () => {
    render(<LogPanel />);

    fireEvent.doubleClick(screen.getByText('first complete log line'));
    fireEvent.click(screen.getByText('third complete log line'), {
      shiftKey: true,
    });

    expect(
      screen.getByText('workbench.logs.selectedCount:3'),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'common.copy' }),
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        'first complete log line\nsecond complete log line\nthird complete log line',
      );
    });
    expect(screen.getByText('workbench.logs.copied')).toBeInTheDocument();
  });

  it('selects all visible rows and clears the selection', () => {
    render(<LogPanel />);

    fireEvent.doubleClick(screen.getByText('first complete log line'));
    fireEvent.click(
      screen.getByRole('button', { name: 'workbench.logs.selectAll' }),
    );

    expect(
      screen.getByText('workbench.logs.selectedCount:3'),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'common.cancel' }),
    );
    expect(
      screen.queryByText('workbench.logs.selectedCount:3'),
    ).not.toBeInTheDocument();
  });

  it('toggles arbitrary rows with Ctrl-click', () => {
    render(<LogPanel />);

    fireEvent.doubleClick(screen.getByText('first complete log line'));
    fireEvent.click(screen.getByText('third complete log line'), {
      ctrlKey: true,
    });
    expect(
      screen.getByText('workbench.logs.selectedCount:2'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText('first complete log line'), {
      ctrlKey: true,
    });
    expect(
      screen.getByText('workbench.logs.selectedCount:1'),
    ).toBeInTheDocument();
  });

  it('clears the selection when Escape is pressed', () => {
    render(<LogPanel />);

    fireEvent.doubleClick(screen.getByText('first complete log line'));
    expect(
      screen.getByText('workbench.logs.selectedCount:1'),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.queryByText('workbench.logs.selectedCount:1'),
    ).not.toBeInTheDocument();
  });
});
