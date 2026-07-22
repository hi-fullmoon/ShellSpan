import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SftpFileList } from '../sftp-file-list';
import type { FileEntry } from '../file-entry-formatters';

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
  }),
}));

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
}

function renderFileList(options: RenderOptions = {}) {
  const {
    entries = sampleEntries,
    currentPath,
    filterQuery = '',
    side = 'local',
    batchMode = false,
  } = options;

  return render(
    <SftpFileList
      entries={entries}
      side={side}
      selectedPaths={[]}
      filterQuery={filterQuery}
      batchMode={batchMode}
      currentPath={currentPath}
      onSelect={vi.fn()}
      onDoubleClick={vi.fn()}
      onContextMenu={vi.fn()}
      onBlankContextMenu={vi.fn()}
      onParentDirectory={vi.fn()}
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

    fireEvent.contextMenu(screen.getByText('a.txt'));

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
    const firstRow = screen.getByText('a.txt').closest('.grid');
    const secondRow = screen.getByText('z.txt').closest('.grid');
    const firstRowCells = firstRow?.querySelectorAll('[data-sftp-file-cell]') ?? [];
    const secondRowCells = secondRow?.querySelectorAll('[data-sftp-file-cell]') ?? [];

    fireEvent.click(screen.getByText('a.txt'));
    fireEvent.click(screen.getByText('z.txt'));

    expect(firstRow).not.toHaveClass('bg-app-primary/10', 'border-b');
    expect(secondRow).not.toHaveClass('bg-app-primary/10', 'border-b');
    firstRowCells.forEach((cell) => expect(cell).toHaveClass('bg-app-primary/10', 'border-b'));
    secondRowCells.forEach((cell) => expect(cell).toHaveClass('bg-app-primary/10', 'border-b'));

    fireEvent.click(screen.getByText('a.txt'));
    firstRowCells.forEach((cell) => expect(cell).not.toHaveClass('bg-app-primary/10'));
    secondRowCells.forEach((cell) => expect(cell).toHaveClass('bg-app-primary/10'));
  });
});
