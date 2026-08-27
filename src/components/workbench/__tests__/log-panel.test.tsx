import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('renders the header refresh action as a text button', () => {
    render(<LogPanel />);

    expect(screen.getByRole('button', { name: 'common.refresh' }))
      .toHaveTextContent('common.refresh');
    const search = screen.getByRole('textbox', {
      name: 'workbench.logs.searchPlaceholder',
    });
    expect(search.parentElement).toHaveAttribute('data-slot', 'input-group');
    expect(search.parentElement).toHaveClass(
      'min-w-0',
      'w-72',
      'max-w-full',
      'flex-none',
    );
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

    expect(document.querySelector('[class~="@container"]')).toBeInTheDocument();
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

  it('opens a structured log entry in the details inspector', () => {
    const today = new Date();
    const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    mockContent =
      `[${todayString}][12:34:57][ERROR][termbridge::connect] something failed badly`;

    render(<LogPanel />);

    fireEvent.click(screen.getByText('something failed badly'));

    expect(screen.getByText('workbench.logs.inspector.title')).toBeInTheDocument();
    expect(screen.getByText('termbridge::connect')).toBeInTheDocument();
    expect(screen.getByText('workbench.logs.inspector.raw')).toBeInTheDocument();
    expect(
      screen.getByText('workbench.logs.inspector.title').closest('aside'),
    ).toHaveClass('@max-[760px]:absolute');
    expect(screen.getByRole('button', {
      name: 'workbench.logs.inspector.copy',
    })).toBeInTheDocument();
  });

  it('shows copy success inside the inspector button without a toast', async () => {
    vi.useFakeTimers();
    const today = new Date();
    const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    mockContent =
      `[${todayString}][12:34:57][ERROR][termbridge] copy this entry`;

    render(<LogPanel />);
    fireEvent.click(screen.getByText('copy this entry'));
    mockAddToast.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', {
        name: 'workbench.logs.inspector.copy',
      }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(mockContent);
    expect(screen.getByRole('button', {
      name: 'workbench.logs.inspector.copied',
    })).toBeInTheDocument();
    expect(mockAddToast).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole('button', {
      name: 'workbench.logs.inspector.copy',
    })).toBeInTheDocument();
  });

  it('keeps multiline entries in uniform single-line rows', () => {
    const today = new Date();
    const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    mockContent =
      `[${todayString}][12:34:57][ERROR][termbridge] something failed\n` +
      'Error: stack trace\n    at render (app.tsx:1:1)';

    render(<LogPanel />);

    const logRow = screen.getByRole('button', { name: /something failed/ });
    const message = logRow.querySelector('span:last-child');
    expect(message).toHaveClass('truncate', 'whitespace-nowrap');
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
