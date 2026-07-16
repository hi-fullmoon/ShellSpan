import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SftpParentRow } from '../sftp-parent-row';

describe('SftpParentRow', () => {
  it('renders .. and triggers parent navigation on click', () => {
    const onParentDirectory = vi.fn();
    render(
      <SftpParentRow
        side="remote"
        batchMode={false}
        onParentDirectory={onParentDirectory}
      />,
    );
    expect(screen.getByText('..')).toBeInTheDocument();
    fireEvent.click(screen.getByText('..'));
    expect(onParentDirectory).toHaveBeenCalledTimes(1);
  });

  it('triggers parent navigation on double click', () => {
    const onParentDirectory = vi.fn();
    render(
      <SftpParentRow
        side="remote"
        batchMode={false}
        onParentDirectory={onParentDirectory}
      />,
    );
    fireEvent.doubleClick(screen.getByText('..'));
    expect(onParentDirectory).toHaveBeenCalledTimes(1);
  });

  it('calls blank context menu on right click', () => {
    const onBlankContextMenu = vi.fn();
    render(
      <SftpParentRow
        side="remote"
        batchMode={false}
        onParentDirectory={vi.fn()}
        onBlankContextMenu={onBlankContextMenu}
      />,
    );
    fireEvent.contextMenu(screen.getByText('..'));
    expect(onBlankContextMenu).toHaveBeenCalledTimes(1);
  });
});
