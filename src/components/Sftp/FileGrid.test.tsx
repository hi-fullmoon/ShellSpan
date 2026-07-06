import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileGrid } from './FileGrid';
import type { LocalFileEntry } from '@/types';

describe('FileGrid', () => {
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
      <FileGrid
        entries={entries}
        selectedPaths={new Set()}
        side="remote"
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
      <FileGrid
        entries={entries}
        selectedPaths={new Set()}
        side="remote"
        onSelect={onSelect}
        onDoubleClick={vi.fn()}
        onContextMenu={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByText('file.txt'));
    expect(onSelect).toHaveBeenCalledWith('/home/file.txt', false);
  });
});
