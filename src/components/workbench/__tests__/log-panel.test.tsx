import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogPanel } from '../log-panel';

const mockAddToast = vi.fn();

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({
    toast: mockAddToast,
    info: mockAddToast,
    success: mockAddToast,
    error: mockAddToast,
  }),
}));

const loadFiles = vi.fn().mockResolvedValue(undefined);
const loadFile = vi.fn().mockResolvedValue(undefined);
const refreshActiveFile = vi.fn().mockResolvedValue(undefined);
const defaultContent =
  'first complete log line\nsecond complete log line\nthird complete log line';
let mockContent = defaultContent;

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
    content: mockContent,
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
    mockAddToast.mockClear();
    mockContent = defaultContent;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows recent log entries by default', () => {
    const today = new Date().toISOString().split('T')[0];
    mockContent =
      `[${today}][12:34:56][INFO][termbridge] persisted log entry`;

    render(<LogPanel />);

    expect(screen.getByText('persisted log entry')).toBeInTheDocument();
  });

  it('shows an empty-filter message when no log entries match', () => {
    mockContent =
      '[2000-01-01][12:34:56][INFO][termbridge] persisted log entry\n';

    render(<LogPanel />);

    expect(
      screen.getByText('workbench.logs.noMatches'),
    ).toBeInTheDocument();
    expect(screen.queryByText('persisted log entry')).not.toBeInTheDocument();
  });

  it('copies one complete raw log line on a double click', async () => {
    render(<LogPanel />);

    fireEvent.doubleClick(screen.getByText('second complete log line'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('second complete log line');
    });
    expect(mockAddToast).toHaveBeenCalledWith('workbench.logs.copied');
  });

  it('displays all date filter options and marks today as selected', () => {
    render(<LogPanel />);

    for (const label of [
      'workbench.logs.today',
      'workbench.logs.last3days',
      'workbench.logs.last7days',
      'workbench.logs.last30days',
      'workbench.logs.all',
    ]) {
      expect(screen.getAllByRole('button', { name: label }).length).toBeGreaterThan(0);
    }
    expect(
      screen.getByRole('button', { name: 'workbench.logs.today' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('displays all level filter options and marks all as selected', () => {
    render(<LogPanel />);

    for (const level of ['INFO', 'WARN', 'ERROR', 'DEBUG']) {
      expect(screen.getByRole('button', { name: level })).toBeInTheDocument();
    }
    expect(
      screen.getAllByRole('button', { name: 'workbench.logs.all' })[1],
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
