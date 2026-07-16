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

  it('hides remote-only items for local side', () => {
    renderMenu({ side: 'local', selectedEntries: [createRemoteFileEntry('local.txt')] });
    expect(screen.queryByText('sftp.contextMenu.newFile')).not.toBeInTheDocument();
    expect(screen.queryByText('sftp.contextMenu.uploadFile')).not.toBeInTheDocument();
    expect(screen.queryByText('common.download')).not.toBeInTheDocument();
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
