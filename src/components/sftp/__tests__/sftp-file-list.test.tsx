import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SftpFileList } from '../sftp-file-list';
import type { FileEntry } from '../utils';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en-US',
  }),
}));

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, className, viewportRef, ...props }: any) => (
    <div data-slot="scroll-area" className={className} {...props}>
      <div ref={viewportRef} data-slot="scroll-area-viewport">
        {children}
      </div>
    </div>
  ),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * estimateSize(),
        end: (index + 1) * estimateSize(),
        size: estimateSize(),
        key: index,
        lane: 0,
      })),
    getTotalSize: () => count * estimateSize(),
    scrollToIndex: vi.fn(),
  }),
}));

// File names render as separate stem + extension spans, so match the name
// container element by its combined text content.
function getFileName(name: string): HTMLElement {
  return screen.getByText(
    (_, element) =>
      element?.classList.contains('text-[13px]') === true &&
      element.textContent === name,
  );
}

const sampleEntries: FileEntry[] = [
  { path: '/home/user/z.txt', name: 'z.txt', kind: 'file', size: 10, modifiedAt: 1000 },
  { path: '/home/user/a.txt', name: 'a.txt', kind: 'file', size: 20, modifiedAt: 2000 },
  { path: '/home/user/report.txt', name: 'report.txt', kind: 'file', size: 30, modifiedAt: 3000 },
];

interface RenderOptions {
  entries?: FileEntry[];
  currentPath?: string;
  filterQuery?: string;
  side?: 'local' | 'remote';
  batchMode?: boolean;
  selectedPaths?: string[];
  onSelect?: (paths: string[]) => void;
  onDoubleClick?: (entry: FileEntry) => void;
  onParentDirectory?: () => void;
}

function renderFileList(options: RenderOptions = {}) {
  const {
    entries = sampleEntries,
    currentPath,
    filterQuery = '',
    side = 'local',
    batchMode = false,
    selectedPaths = [],
    onSelect = vi.fn(),
    onDoubleClick = vi.fn(),
    onParentDirectory = vi.fn(),
  } = options;

  return render(
    <SftpFileList
      entries={entries}
      side={side}
      selectedPaths={selectedPaths}
      filterQuery={filterQuery}
      batchMode={batchMode}
      currentPath={currentPath}
      onSelect={onSelect}
      onDoubleClick={onDoubleClick}
      onContextMenu={vi.fn()}
      onBlankContextMenu={vi.fn()}
      onParentDirectory={onParentDirectory}
    />,
  );
}

describe('SftpFileList', () => {
  it('keeps the header aligned with horizontal content scrolling', () => {
    const { container } = renderFileList({ side: 'remote' });
    const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const headerViewport = screen.getByTestId('sftp-file-list-header-viewport');

    expect(viewport).not.toBeNull();
    viewport!.scrollLeft = 180;
    fireEvent.scroll(viewport!);

    expect(headerViewport.scrollLeft).toBe(180);
  });

  it('places the scrolling header background on each column cell', () => {
    renderFileList({ side: 'remote' });
    const headerViewport = screen.getByTestId('sftp-file-list-header-viewport');
    const headerCells = headerViewport.querySelectorAll('button');

    expect(headerViewport).not.toHaveClass('bg-app-surface-muted');
    expect(headerCells).toHaveLength(6);
    headerCells.forEach((cell) => expect(cell).toHaveClass('bg-app-surface-muted'));
  });

  it('cycles sort direction through asc, desc, default on name column', async () => {
    renderFileList({ entries: sampleEntries });
    const nameHeader = screen.getByText('sftp.columns.name');

    await userEvent.click(nameHeader);
    expect(screen.getAllByTestId('sftp-row')[0]).toHaveTextContent('a.txt');

    await userEvent.click(nameHeader);
    expect(screen.getAllByTestId('sftp-row')[0]).toHaveTextContent('z.txt');

    await userEvent.click(nameHeader);
    expect(screen.getAllByTestId('sftp-row')[0]).toHaveTextContent('a.txt');
  });

  it('sorts the kind column in both ascending and descending directions', async () => {
    const mixedEntries: FileEntry[] = [
      { path: '/home/user/file.txt', name: 'file.txt', kind: 'file' },
      { path: '/home/user/folder', name: 'folder', kind: 'directory' },
      { path: '/home/user/link', name: 'link', kind: 'symlink' },
      { path: '/home/user/device', name: 'device', kind: 'other' },
    ];
    renderFileList({ entries: mixedEntries });
    const kindHeader = screen.getByText('sftp.columns.type');

    await userEvent.click(kindHeader);
    expect(screen.getAllByTestId('sftp-row').map((row) => row.textContent)).toEqual([
      expect.stringContaining('folder'),
      expect.stringContaining('file.txt'),
      expect.stringContaining('device'),
      expect.stringContaining('link'),
    ]);

    await userEvent.click(kindHeader);
    expect(screen.getAllByTestId('sftp-row').map((row) => row.textContent)).toEqual([
      expect.stringContaining('link'),
      expect.stringContaining('device'),
      expect.stringContaining('file.txt'),
      expect.stringContaining('folder'),
    ]);
  });

  it('keeps parent row at top after sorting', () => {
    renderFileList({ entries: sampleEntries, currentPath: '/home/user' });
    expect(screen.getAllByTestId('sftp-parent-row')[0]).toHaveTextContent('..');

    fireEvent.click(screen.getByText('sftp.columns.size'));
    expect(screen.getAllByTestId('sftp-parent-row')[0]).toHaveTextContent('..');
  });

  it('filters entries but keeps parent row', () => {
    renderFileList({
      entries: sampleEntries,
      currentPath: '/home/user',
      filterQuery: 'report',
    });

    const rows = screen.getAllByTestId(/sftp-row|sftp-parent-row/);
    expect(rows[0]).toHaveTextContent('..');
    expect(rows.length).toBeGreaterThan(1);
  });

  it('navigates to parent directory only when parent row is double-clicked', () => {
    const onParentDirectory = vi.fn();
    render(
      <SftpFileList
        entries={sampleEntries}
        side="local"
        selectedPaths={[]}
        filterQuery=""
        batchMode={false}
        currentPath="/home/user"
        onSelect={vi.fn()}
        onDoubleClick={vi.fn()}
        onContextMenu={vi.fn()}
        onBlankContextMenu={vi.fn()}
        onParentDirectory={onParentDirectory}
      />,
    );
    fireEvent.click(screen.getByText('..'));
    expect(onParentDirectory).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByText('..'));
    expect(onParentDirectory).toHaveBeenCalledTimes(1);
  });

  it('calls blank context menu exactly once when right-clicking parent row', () => {
    const onBlankContextMenu = vi.fn();
    render(
      <SftpFileList
        entries={sampleEntries}
        side="local"
        selectedPaths={[]}
        filterQuery=""
        batchMode={false}
        currentPath="/home/user"
        onSelect={vi.fn()}
        onDoubleClick={vi.fn()}
        onContextMenu={vi.fn()}
        onBlankContextMenu={onBlankContextMenu}
        onParentDirectory={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByText('..'));
    expect(onBlankContextMenu).toHaveBeenCalledTimes(1);
  });

  it('only opens the file context menu when right-clicking a file row', () => {
    const onContextMenu = vi.fn();
    const onBlankContextMenu = vi.fn();
    render(
      <SftpFileList
        entries={sampleEntries}
        side="local"
        selectedPaths={[]}
        filterQuery=""
        batchMode={false}
        onSelect={vi.fn()}
        onDoubleClick={vi.fn()}
        onContextMenu={onContextMenu}
        onBlankContextMenu={onBlankContextMenu}
        onParentDirectory={vi.fn()}
      />,
    );

    fireEvent.contextMenu(getFileName('a.txt'));

    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onBlankContextMenu).not.toHaveBeenCalled();
  });

  it('toggles multiple rows with plain clicks in batch mode', () => {
    const Harness = () => {
      const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
      return (
        <SftpFileList
          entries={sampleEntries}
          side="local"
          selectedPaths={selectedPaths}
          filterQuery=""
          batchMode
          onSelect={setSelectedPaths}
          onDoubleClick={vi.fn()}
          onContextMenu={vi.fn()}
          onBlankContextMenu={vi.fn()}
          onParentDirectory={vi.fn()}
        />
      );
    };

    render(<Harness />);
    const firstRow = getFileName('a.txt').closest('.grid');
    const secondRow = getFileName('z.txt').closest('.grid');
    const firstRowCells = firstRow?.querySelectorAll('[data-sftp-file-cell]') ?? [];
    const secondRowCells = secondRow?.querySelectorAll('[data-sftp-file-cell]') ?? [];

    fireEvent.click(getFileName('a.txt'));
    fireEvent.click(getFileName('z.txt'));

    expect(firstRow).not.toHaveClass('bg-app-primary/10', 'border-b');
    expect(secondRow).not.toHaveClass('bg-app-primary/10', 'border-b');
    firstRowCells.forEach((cell) => expect(cell).toHaveClass('bg-app-primary/10', 'border-b'));
    secondRowCells.forEach((cell) => expect(cell).toHaveClass('bg-app-primary/10', 'border-b'));

    fireEvent.click(getFileName('a.txt'));
    firstRowCells.forEach((cell) => expect(cell).not.toHaveClass('bg-app-primary/10'));
    secondRowCells.forEach((cell) => expect(cell).toHaveClass('bg-app-primary/10'));
  });

  it('resets the shift-range anchor when the directory changes', () => {
    const onSelect = vi.fn();
    const firstEntries: FileEntry[] = [
      { path: '/a/first.txt', name: 'first.txt', kind: 'file' },
      { path: '/a/second.txt', name: 'second.txt', kind: 'file' },
    ];
    const secondEntries: FileEntry[] = [
      { path: '/b/x.txt', name: 'x.txt', kind: 'file' },
      { path: '/b/y.txt', name: 'y.txt', kind: 'file' },
      { path: '/b/z.txt', name: 'z.txt', kind: 'file' },
    ];

    const { rerender } = render(
      <SftpFileList
        entries={firstEntries}
        side="local"
        selectedPaths={[]}
        filterQuery=""
        batchMode
        currentPath="/a"
        onSelect={onSelect}
        onDoubleClick={vi.fn()}
        onContextMenu={vi.fn()}
        onBlankContextMenu={vi.fn()}
        onParentDirectory={vi.fn()}
      />,
    );

    fireEvent.click(getFileName('first.txt'));

    rerender(
      <SftpFileList
        entries={secondEntries}
        side="local"
        selectedPaths={[]}
        filterQuery=""
        batchMode
        currentPath="/b"
        onSelect={onSelect}
        onDoubleClick={vi.fn()}
        onContextMenu={vi.fn()}
        onBlankContextMenu={vi.fn()}
        onParentDirectory={vi.fn()}
      />,
    );

    // With a stale anchor (index 0 from /a), this shift-click would select the
    // whole x..z range; after the reset it toggles only z.txt.
    fireEvent.click(getFileName('z.txt'), { shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith(['/b/z.txt']);
  });

  it('resets the shift-range anchor when the filter changes', () => {
    const onSelect = vi.fn();
    const entries: FileEntry[] = [
      { path: '/a/apple.txt', name: 'apple.txt', kind: 'file' },
      { path: '/a/banana.txt', name: 'banana.txt', kind: 'file' },
      { path: '/a/cherry.txt', name: 'cherry.txt', kind: 'file' },
    ];

    const renderList = (filterQuery: string) => (
      <SftpFileList
        entries={entries}
        side="local"
        selectedPaths={[]}
        filterQuery={filterQuery}
        batchMode
        currentPath="/a"
        onSelect={onSelect}
        onDoubleClick={vi.fn()}
        onContextMenu={vi.fn()}
        onBlankContextMenu={vi.fn()}
        onParentDirectory={vi.fn()}
      />
    );

    const { rerender } = render(renderList(''));
    fireEvent.click(getFileName('cherry.txt'));

    // The stale anchor (index 2 of the unfiltered list) would extend the
    // shift-range over apple..banana; after the reset only apple is toggled.
    rerender(renderList('a'));
    fireEvent.click(getFileName('apple.txt'), { shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith(['/a/apple.txt']);
  });

  it('moves keyboard focus with arrow keys and scrolls it into view', () => {
    renderFileList();
    const listbox = screen.getByRole('listbox');

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('a.txt');
    expect(options[0]).toHaveClass('ring-1', 'ring-app-primary');
    expect(options[1]).not.toHaveClass('ring-1');

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(options[0]).not.toHaveClass('ring-1');
    expect(options[1]).toHaveClass('ring-1', 'ring-app-primary');

    // Clamped at the last row.
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(options[2]).toHaveClass('ring-1', 'ring-app-primary');

    fireEvent.keyDown(listbox, { key: 'ArrowUp' });
    expect(options[1]).toHaveClass('ring-1', 'ring-app-primary');
  });

  it('opens the focused entry with Enter like a double-click', () => {
    const onDoubleClick = vi.fn();
    renderFileList({ onDoubleClick });
    const listbox = screen.getByRole('listbox');

    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(onDoubleClick).not.toHaveBeenCalled();

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
    expect(onDoubleClick).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/home/user/a.txt' }),
    );
  });

  it('navigates to the parent directory with Enter on the parent row', () => {
    const onDoubleClick = vi.fn();
    const onParentDirectory = vi.fn();
    renderFileList({ currentPath: '/home/user', onDoubleClick, onParentDirectory });
    const listbox = screen.getByRole('listbox');

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });

    expect(onParentDirectory).toHaveBeenCalledTimes(1);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it('selects the focused entry with Space in non-batch mode', () => {
    const onSelect = vi.fn();
    renderFileList({ onSelect });
    const listbox = screen.getByRole('listbox');

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: ' ' });

    expect(onSelect).toHaveBeenCalledWith(['/home/user/a.txt']);
  });

  it('toggles the focused entry with Space in batch mode', () => {
    const Harness = () => {
      const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
      return (
        <SftpFileList
          entries={sampleEntries}
          side="local"
          selectedPaths={selectedPaths}
          filterQuery=""
          batchMode
          onSelect={setSelectedPaths}
          onDoubleClick={vi.fn()}
          onContextMenu={vi.fn()}
          onBlankContextMenu={vi.fn()}
          onParentDirectory={vi.fn()}
        />
      );
    };

    render(<Harness />);
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: ' ' });
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(listbox, { key: ' ' });
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('clears the selection with Escape', () => {
    const onSelect = vi.fn();
    renderFileList({ selectedPaths: ['/home/user/a.txt'], onSelect });
    const listbox = screen.getByRole('listbox');

    fireEvent.keyDown(listbox, { key: 'Escape' });

    expect(onSelect).toHaveBeenCalledWith([]);
  });

  it('extends the selection range with Shift+Arrow from the anchor', () => {
    const Harness = () => {
      const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
      return (
        <SftpFileList
          entries={sampleEntries}
          side="local"
          selectedPaths={selectedPaths}
          filterQuery=""
          batchMode
          onSelect={setSelectedPaths}
          onDoubleClick={vi.fn()}
          onContextMenu={vi.fn()}
          onBlankContextMenu={vi.fn()}
          onParentDirectory={vi.fn()}
        />
      );
    };

    render(<Harness />);
    const listbox = screen.getByRole('listbox');
    const options = screen.getAllByRole('option');

    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: ' ' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown', shiftKey: true });

    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[2]).toHaveAttribute('aria-selected', 'false');

    fireEvent.keyDown(listbox, { key: 'ArrowDown', shiftKey: true });
    expect(options[2]).toHaveAttribute('aria-selected', 'true');
  });

  it('ignores keys pressed in the filter input outside the list', () => {
    const onSelect = vi.fn();
    const onDoubleClick = vi.fn();
    render(
      <div>
        <input data-testid="filter-input" />
        <SftpFileList
          entries={sampleEntries}
          side="local"
          selectedPaths={[]}
          filterQuery=""
          batchMode={false}
          onSelect={onSelect}
          onDoubleClick={onDoubleClick}
          onContextMenu={vi.fn()}
          onBlankContextMenu={vi.fn()}
          onParentDirectory={vi.fn()}
        />
      </div>,
    );

    const filterInput = screen.getByTestId('filter-input');
    fireEvent.keyDown(filterInput, { key: 'ArrowDown' });
    fireEvent.keyDown(filterInput, { key: 'Enter' });
    fireEvent.keyDown(filterInput, { key: ' ' });
    fireEvent.keyDown(filterInput, { key: 'Escape' });

    screen.getAllByRole('option').forEach((option) => {
      expect(option).not.toHaveClass('ring-1');
      expect(option).toHaveAttribute('aria-selected', 'false');
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDoubleClick).not.toHaveBeenCalled();
  });
});
