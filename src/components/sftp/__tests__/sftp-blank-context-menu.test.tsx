import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SftpBlankContextMenu, type SftpBlankContextMenuAction } from '../sftp-blank-context-menu';
import { useSftpStore } from '@/stores/sftpStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en-US',
  }),
}));

const initialState = useSftpStore.getState();

describe('SftpBlankContextMenu', () => {
  beforeEach(() => {
    useSftpStore.setState(initialState, true);
  });

  const renderMenu = (props: Partial<React.ComponentProps<typeof SftpBlankContextMenu>> = {}) => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    const utils = render(
      <SftpBlankContextMenu
        open
        x={100}
        y={100}
        side="remote"
        currentPath="/home"
        hasClipboard={false}
        isBookmarked={false}
        batchMode={false}
        onClose={onClose}
        onAction={onAction}
        {...props}
      />,
    );
    return { onAction, onClose, ...utils };
  };

  it('renders all menu items for remote blank area', () => {
    renderMenu();
    expect(screen.getByText('sftp.contextMenu.newFile')).toBeInTheDocument();
    expect(screen.getByText('common.newFolder')).toBeInTheDocument();
    expect(screen.getByText('sftp.contextMenu.uploadFile')).toBeInTheDocument();
    expect(screen.getByText('sftp.contextMenu.uploadFolder')).toBeInTheDocument();
    expect(screen.getByText('sftp.contextMenu.paste')).toBeInTheDocument();
    expect(screen.getByText('sftp.contextMenu.copyCurrentDirectoryPath')).toBeInTheDocument();
    expect(screen.getByText('sftp.contextMenu.batch.enter')).toBeInTheDocument();
    expect(screen.getByText('common.refresh')).toBeInTheDocument();
    expect(screen.getByText('sftp.contextMenu.bookmark.add')).toBeInTheDocument();
  });

  it('disables paste when clipboard is empty', () => {
    renderMenu({ hasClipboard: false });
    const pasteButton = screen.getByText('sftp.contextMenu.paste').closest('button');
    expect(pasteButton).toBeDisabled();
  });

  it('enables paste when clipboard has data', () => {
    renderMenu({ hasClipboard: true });
    const pasteButton = screen.getByText('sftp.contextMenu.paste').closest('button');
    expect(pasteButton).not.toBeDisabled();
  });

  it('shows bookmark remove when path is bookmarked', () => {
    renderMenu({ isBookmarked: true });
    expect(screen.getByText('sftp.contextMenu.bookmark.remove')).toBeInTheDocument();
  });

  it('shows batch exit when batch mode is active', () => {
    renderMenu({ batchMode: true });
    expect(screen.getByText('sftp.contextMenu.batch.exit')).toBeInTheDocument();
  });

  it('hides remote-only items for local side', () => {
    renderMenu({ side: 'local' });
    expect(screen.queryByText('sftp.contextMenu.newFile')).not.toBeInTheDocument();
    expect(screen.queryByText('sftp.contextMenu.paste')).not.toBeInTheDocument();
    expect(screen.queryByText('sftp.contextMenu.bookmark.add')).not.toBeInTheDocument();
  });

  it('fires action when clicking a menu item', () => {
    const { onAction } = renderMenu();
    fireEvent.click(screen.getByText('sftp.contextMenu.newFile'));
    expect(onAction).toHaveBeenCalledWith('newFile');
  });
});
