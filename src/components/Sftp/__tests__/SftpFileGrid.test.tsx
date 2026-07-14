import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SftpFileGrid } from '../SftpFileGrid';
import type { LocalFileEntry } from '@/types';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en-US',
  }),
}));

const mockGridRows: Array<{ path: string; name: string; kind: string }> = [];
const mockSetSelectedRows = vi.fn();

vi.mock('ag-grid-react', () => ({
  AgGridReact: ({
    rowData,
    onRowDoubleClicked,
    onSelectionChanged,
  }: {
    rowData: Array<{ path: string; name: string; kind: string }>;
    onRowDoubleClicked?: (event: { data?: { path: string; kind: string } }) => void;
    onSelectionChanged?: (event: {
      api: { getSelectedRows: () => Array<{ path: string; name: string; kind: string }> };
    }) => void;
  }) => {
    mockGridRows.length = 0;
    mockGridRows.push(...rowData);
    return (
      <div data-testid="mock-ag-grid">
        {rowData.map((row) => (
          <div
            key={row.path}
            data-testid={`ag-row-${row.name}`}
            onClick={() => {
              mockSetSelectedRows([row]);
              onSelectionChanged?.({ api: { getSelectedRows: () => [row] } });
            }}
            onDoubleClick={() => onRowDoubleClicked?.({ data: row })}
          >
            {row.name}
          </div>
        ))}
      </div>
    );
  },
}));

vi.mock('@/hooks/useTheme', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

describe('SftpFileGrid', () => {
  beforeEach(() => {
    mockSetSelectedRows.mockClear();
  });

  const entries: LocalFileEntry[] = [
    {
      path: '/home/file.txt',
      name: 'file.txt',
      kind: 'file',
      size: 1024,
      modifiedAt: 1700000000,
    },
    {
      path: '/home/docs',
      name: 'docs',
      kind: 'directory',
    },
  ];

  it('renders file entries', () => {
    render(
      <SftpFileGrid
        entries={entries}
        side="local"
        selectedPaths={[]}
        filterQuery=""
        batchMode={false}
        onSelect={vi.fn()}
        onDoubleClick={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    expect(screen.getByText('file.txt')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
  });

  it('calls onSelect when a row is clicked', async () => {
    const onSelect = vi.fn();
    render(
      <SftpFileGrid
        entries={entries}
        side="local"
        selectedPaths={[]}
        filterQuery=""
        batchMode={false}
        onSelect={onSelect}
        onDoubleClick={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByText('file.txt'));
    expect(onSelect).toHaveBeenCalledWith(['/home/file.txt']);
  });

  it('filters entries by query', () => {
    render(
      <SftpFileGrid
        entries={entries}
        side="local"
        selectedPaths={[]}
        filterQuery="doc"
        batchMode={false}
        onSelect={vi.fn()}
        onDoubleClick={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    expect(screen.queryByText('file.txt')).not.toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
  });

  it('calls onDoubleClick when a row is double clicked', async () => {
    const onDoubleClick = vi.fn();
    render(
      <SftpFileGrid
        entries={entries}
        side="local"
        selectedPaths={[]}
        filterQuery=""
        batchMode={false}
        onSelect={vi.fn()}
        onDoubleClick={onDoubleClick}
        onContextMenu={vi.fn()}
      />,
    );
    await userEvent.dblClick(screen.getByText('docs'));
    expect(onDoubleClick).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/home/docs', name: 'docs', kind: 'directory' }),
    );
  });
});
