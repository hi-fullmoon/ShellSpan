import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SftpFileContextMenu, type SftpFileContextMenuAction } from '../sftp-file-context-menu';
import { useSftpStore } from '@/stores/sftpStore';
import type { FileEntry } from '../file-entry-formatters';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en-US',
  }),
}));

const initialState = useSftpStore.getState();

const createRemoteFileEntry = (name: string): FileEntry => ({
  path: `/home/${name}`,
  name,
  kind: 'file',
  size: 100,
  modifiedAt: 1234567890,
  permissions: 0o644,
  ownerUid: 1000,
  groupGid: 1000,
});

const createRemoteDirectoryEntry = (name: string): FileEntry => ({
  path: `/home/${name}`,
  name,
  kind: 'directory',
  modifiedAt: 1234567890,
  permissions: 0o755,
  ownerUid: 1000,
  groupGid: 1000,
});

describe('SftpFileContextMenu', () => {
  beforeEach(() => {
    useSftpStore.setState(initialState, true);
  });

  const renderMenu = (props: Partial<React.ComponentProps<typeof SftpFileContextMenu>> = {}) => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    const selectedEntries = props.selectedEntries ?? [createRemoteFileEntry('test.txt')];
    const utils = render(
      <SftpFileContextMenu
        open
        x={100}
        y={100}
        side="remote"
        currentPath="/home"
        selectedEntries={selectedEntries}
        isBookmarked={false}
        batchMode={false}
        onClose={onClose}
        onAction={onAction}
        {...props}
      />,
    );
    return { onAction, onClose, ...utils };
  };

  it('renders all menu items for a remote file', () => {
    renderMenu();
    expect(screen.getByText('sftp.contextMenu.newFile')).toBeInTheDocument();
    expect(screen.getByText('common.newFolder')).toBeInTheDocument();
    expect(screen.getByText('sftp.contextMenu.uploadFile')).toBeInTheDocument();
    expect(screen.getByText('sftp.contextMenu.uploadFolder')).toBeInTheDocument();
    expect(screen.getByText('sftp.contextMenu.openWithDefaultEditor')).toBeInTheDocument();
    expect(screen.getByText('sftp.contextMenu.preview')).toBeInTheDocument();
    expect(screen.getByText('common.download')).toBeInTheDocument();
    expect(screen.getByText('common.rename')).toBeInTheDocument();
    expect(screen.getByText('sftp.contextMenu.copy')).toBeInTheDocument();
    expect(screen.getByText('common.delete')).toBeInTheDocument();
    expect(screen.getByText('common.properties')).toBeInTheDocument();
  });

  it('disables open, preview, openWithDefaultEditor for remote directory', () => {
    renderMenu({ selectedEntries: [createRemoteDirectoryEntry('dir')] });
    const openButton = screen.getByText('sftp.contextMenu.open').closest('button');
    expect(openButton).not.toBeDisabled();
    const previewButton = screen.getByText('sftp.contextMenu.preview').closest('button');
    expect(previewButton).toBeDisabled();
    const editorButton = screen.getByText('sftp.contextMenu.openWithDefaultEditor').closest('button');
    expect(editorButton).toBeDisabled();
  });

  it('fires action when clicking a menu item', () => {
    const { onAction } = renderMenu();
    fireEvent.click(screen.getByText('sftp.contextMenu.preview'));
    expect(onAction).toHaveBeenCalledWith('preview');
  });

  it('disables conflicting actions while the selected path is busy', () => {
    renderMenu({ selectionBusy: true });

    expect(screen.getByText('common.download').closest('button')).toBeDisabled();
    expect(screen.getByText('common.rename').closest('button')).toBeDisabled();
    expect(screen.getByText('common.delete').closest('button')).toBeDisabled();
  });

  it('does not delete until the confirmation is accepted', () => {
    const { onAction, onClose } = renderMenu();

    fireEvent.click(screen.getByText('common.delete'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByText('sftp.deleteConfirm.title')).toBeInTheDocument();

    fireEvent.click(screen.getByText('common.cancel'));
    expect(onAction).not.toHaveBeenCalled();
  });

  it('deletes only after the destructive confirmation is accepted', () => {
    const { onAction } = renderMenu();

    fireEvent.click(screen.getByText('common.delete'));
    fireEvent.click(screen.getByText('common.delete'));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('delete', [createRemoteFileEntry('test.txt')]);
  });

  it('deletes the snapshot taken when the dialog opened, not the live selection', () => {
    const { onAction, rerender } = renderMenu({
      selectedEntries: [createRemoteFileEntry('first.txt')],
    });

    fireEvent.click(screen.getByText('common.delete'));

    // The selection changes while the confirmation dialog is open.
    rerender(
      <SftpFileContextMenu
        open={false}
        x={100}
        y={100}
        side="remote"
        currentPath="/home"
        selectedEntries={[createRemoteFileEntry('second.txt')]}
        isBookmarked={false}
        batchMode={false}
        onClose={vi.fn()}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByText('common.delete'));
    expect(onAction).toHaveBeenCalledWith('delete', [createRemoteFileEntry('first.txt')]);
  });

  it('uses the multi-item confirmation for a batch selection', () => {
    renderMenu({
      selectedEntries: [
        createRemoteFileEntry('first.txt'),
        createRemoteFileEntry('second.txt'),
      ],
    });

    fireEvent.click(screen.getByText('common.delete'));

    expect(screen.getByText('sftp.deleteConfirm.multiple')).toBeInTheDocument();
  });

  it('wraps a long file name inside the confirmation dialog', () => {
    renderMenu({
      selectedEntries: [
        createRemoteFileEntry('a-very-long-file-name-without-any-natural-break-points.txt'),
      ],
    });

    fireEvent.click(screen.getByText('common.delete'));

    expect(screen.getByText('sftp.deleteConfirm.single')).toHaveClass('break-all');
  });

  it('hides remote-only items for local side', () => {
    renderMenu({ side: 'local', selectedEntries: [createRemoteFileEntry('local.txt')] });
    expect(screen.queryByText('sftp.contextMenu.newFile')).not.toBeInTheDocument();
    expect(screen.queryByText('sftp.contextMenu.uploadFile')).not.toBeInTheDocument();
    expect(screen.queryByText('common.download')).not.toBeInTheDocument();
  });

  it('enables rename, copy, and delete for the local side', () => {
    renderMenu({ side: 'local', selectedEntries: [createRemoteFileEntry('local.txt')] });
    expect(screen.getByText('common.rename').closest('button')).not.toBeDisabled();
    expect(screen.getByText('sftp.contextMenu.copy').closest('button')).not.toBeDisabled();
    expect(screen.getByText('common.delete').closest('button')).not.toBeDisabled();
  });

  it('closes on escape key', () => {
    const { onClose } = renderMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on pointer down outside without blocking the page', () => {
    const { onClose } = renderMenu();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays open on pointer down inside the menu', () => {
    const { onClose } = renderMenu();
    fireEvent.pointerDown(screen.getByText('sftp.contextMenu.preview'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
