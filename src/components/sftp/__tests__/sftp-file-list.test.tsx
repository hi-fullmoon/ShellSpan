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

  it('navigates to parent directory when parent row is clicked', () => {
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
});
