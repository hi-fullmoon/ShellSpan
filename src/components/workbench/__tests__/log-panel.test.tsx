import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HTMLAttributes, ReactNode, Ref } from 'react';
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

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({
    children,
    viewportRef,
    horizontal: _horizontal,
    ...props
  }: HTMLAttributes<HTMLDivElement> & {
    children?: ReactNode;
    viewportRef?: Ref<HTMLDivElement>;
    horizontal?: boolean;
  }) => (
    <div data-slot="scroll-area" {...props}>
      <div ref={viewportRef} data-slot="scroll-area-viewport">
        {children}
      </div>
    </div>
  ),
}));

const loadFiles = vi.fn().mockResolvedValue(undefined);
const loadFile = vi.fn().mockResolvedValue(undefined);
const refreshActiveFile = vi.fn().mockResolvedValue(undefined);
const scrollToIndex = vi.fn();
const defaultContent =
  'first complete log line\nsecond complete log line\nthird complete log line';
let mockContent = defaultContent;
let mockFiles: { name: string; size: number; modifiedAt: number }[] = [];
let mockActiveFileName: string | undefined = 'termbridge.log';
let mockActiveSource: 'frontend' | 'backend' = 'frontend';
const setActiveSource = vi.fn();

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) => {
      if (variables?.count !== undefined) {
        return `${key}:${variables.count}`;
      }
      if (variables?.source !== undefined) {
        return `${key}:${variables.source}`;
      }
      return key;
    },
  }),
}));

vi.mock('@/stores/logStore', () => ({
  useLogStore: () => ({
    files: mockFiles,
    activeFileName: mockActiveFileName,
    activeSource: mockActiveSource,
    content: mockContent,
    loading: false,
    loadFiles,
    loadFile,
    refreshActiveFile,
    setActiveSource,
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
    scrollToIndex,
  }),
}));

describe('LogPanel', () => {
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    mockAddToast.mockClear();
    mockContent = defaultContent;
    mockFiles = [];
    mockActiveFileName = 'termbridge.log';
    mockActiveSource = 'frontend';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows recent log entries by default', () => {
    const today = new Date();
    const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    mockContent =
      `[${todayString}][12:34:56][INFO][termbridge] persisted log entry`;

    render(<LogPanel />);

    expect(screen.getByText('persisted log entry')).toBeInTheDocument();
  });

  it('does not render a footer status bar', () => {
    render(<LogPanel />);

    expect(screen.queryByText(/workbench\.logs\.lineCount/)).not.toBeInTheDocument();
    expect(screen.queryByText('workbench.logs.copyHint')).not.toBeInTheDocument();
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

  it('filters log entries by the search query', () => {
    const today = new Date();
    const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    mockContent =
      `[${todayString}][12:34:56][INFO][termbridge] persisted log entry\n` +
      `[${todayString}][12:34:57][ERROR][termbridge] something failed badly`;

    render(<LogPanel />);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'failed' },
    });

    expect(screen.queryByText('persisted log entry')).not.toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
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

  it('uses a stable hover target for the auto-scroll tooltip', () => {
    render(<LogPanel />);

    const autoScrollSwitch = screen.getByRole('switch', {
      name: 'workbench.logs.autoScroll',
    });
    const tooltipTrigger = autoScrollSwitch.parentElement;

    expect(tooltipTrigger).toHaveAttribute('data-slot', 'tooltip-trigger');
    expect(tooltipTrigger).toHaveClass('h-7');
    expect(tooltipTrigger).not.toHaveClass('size-7');
    expect(autoScrollSwitch).toHaveClass('after:hidden');
  });

  it('shows a floating button away from the bottom and scrolls to the last log line', () => {
    render(<LogPanel />);

    const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    expect(viewport).not.toBeNull();
    Object.defineProperties(viewport as HTMLElement, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });

    fireEvent.scroll(viewport as HTMLElement);

    const scrollButton = screen.getByRole('button', {
      name: 'workbench.logs.scrollToBottom',
    });
    scrollToIndex.mockClear();
    fireEvent.click(scrollButton);

    expect(scrollToIndex).toHaveBeenCalledWith(2, {
      align: 'end',
      behavior: 'smooth',
    });
    expect(screen.queryByRole('button', {
      name: 'workbench.logs.scrollToBottom',
    })).not.toBeInTheDocument();
  });

  it('renders the source switcher next to the title', () => {
    render(<LogPanel />);

    expect(
      screen.getByRole('button', { name: 'workbench.logs.frontend' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: 'workbench.logs.backend' }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches the active log source', () => {
    render(<LogPanel />);

    fireEvent.click(
      screen.getByRole('button', { name: 'workbench.logs.backend' }),
    );

    expect(setActiveSource).toHaveBeenCalledWith('backend');
  });

  it('shows the current source in the empty state description', () => {
    mockActiveFileName = undefined;
    mockContent = '';
    render(<LogPanel />);

    expect(
      screen.getByText('workbench.logs.emptyDescription:workbench.logs.frontend'),
    ).toBeInTheDocument();
  });
});
