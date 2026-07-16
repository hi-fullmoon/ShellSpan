import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SftpParentRow } from '../sftp-parent-row';

describe('SftpParentRow', () => {
  it('renders .. without navigating on single click', () => {
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
    expect(onParentDirectory).not.toHaveBeenCalled();
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

  it('uses the folder color and leaves metadata columns empty', () => {
    const { container } = render(
      <SftpParentRow
        side="remote"
        batchMode={false}
        onParentDirectory={vi.fn()}
      />,
    );

    expect(container.querySelector('svg')).toHaveClass('text-app-primary');
    expect(screen.queryByText('--')).not.toBeInTheDocument();
  });
});
