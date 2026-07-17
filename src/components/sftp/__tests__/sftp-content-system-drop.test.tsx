import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { useSftpStore } from '@/stores/sftpStore';
import type { UseSystemFileDropOptions } from '@/hooks/useSystemFileDrop';
import type { UseSftpPaneActionsResult } from '@/hooks/useSftpPaneActions';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));

vi.mock('@/hooks/useSystemFileDrop', () => ({
  useSystemFileDrop: vi.fn(),
}));

vi.mock('@/hooks/useSftpConnectionOpener', () => ({
  useSftpConnectionOpener: () => ({
    open: vi.fn(),
    verifyHostKey: vi.fn(),
    hostKeyDialog: { open: false },
    closeHostKeyDialog: vi.fn(),
  }),
}));

vi.mock('@/components/ui/split-pane', () => ({
  SplitPane: ({ left, right }: { left: React.ReactNode; right: React.ReactNode }) => (
    <div>
      <div data-testid="left-pane">{left}</div>
      <div data-testid="right-pane">{right}</div>
    </div>
  ),
}));

vi.mock('@/components/sftp/sftp-tab-bar', () => ({
  SftpTabBar: () => <div data-testid="sftp-tab-bar" />,
}));

vi.mock('@/components/sftp/sftp-dnd-context', () => ({
  SftpDndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useSftpConnection', () => ({
  useSftpConnection: () => ({
    loadRemoteDirectory: vi.fn().mockResolvedValue(undefined),
    downloadRemotePaths: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/hooks/useLocalDirectory', () => ({
  useLocalDirectory: () => ({
    loadLocalDirectory: vi.fn().mockResolvedValue(undefined),
    openLocalPath: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/hooks/useSftpPaneActions', () => ({
  useSftpPaneActions: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  invokeListLocalDirectory: vi.fn().mockResolvedValue({ path: '/local', entries: [] }),
  invokeListRemoteDirectory: vi.fn().mockResolvedValue({ path: '/remote', entries: [] }),
}));

const initialState = useSftpStore.getState();

function createConnection() {
  useSftpStore.getState().addConnection(
    { sessionId: 'c1', title: 'Test', host: 'h', port: 22, username: 'u' },
    { host: 'h', port: 22, username: 'u', authMethod: 'password' },
  );
  const connection = useSftpStore.getState().connections[0]!;
  useSftpStore.getState().setPath(connection.id, 'local', '/local');
  useSftpStore.getState().setPath(connection.id, 'remote', '/remote');
  return connection;
}

function createActions(
  overrides: Partial<UseSftpPaneActionsResult> = {},
): UseSftpPaneActionsResult {
  const base: UseSftpPaneActionsResult = {
    createMode: null,
    renameTarget: undefined,
    permissionsTarget: undefined,
    propertiesTarget: undefined,
    previewContent: undefined,
    uploadConflict: undefined,
    onOpen: vi.fn(),
    onOpenWithDefaultEditor: vi.fn().mockResolvedValue(undefined),
    onPreview: vi.fn().mockResolvedValue(undefined),
    onDownload: vi.fn().mockResolvedValue(undefined),
    onBatchDownload: vi.fn().mockResolvedValue(undefined),
    uploadWithPolicies: vi.fn().mockResolvedValue(undefined),
    copyWithPolicies: vi.fn().mockResolvedValue(undefined),
    onCopy: vi.fn(),
    onPaste: vi.fn().mockResolvedValue(undefined),
    onRename: vi.fn(),
    onDelete: vi.fn().mockResolvedValue(undefined),
    onCopyName: vi.fn().mockResolvedValue(undefined),
    onCopyPath: vi.fn().mockResolvedValue(undefined),
    onCopyContainingDirectory: vi.fn().mockResolvedValue(undefined),
    onNewFile: vi.fn(),
    onNewFolder: vi.fn(),
    onUploadFiles: vi.fn().mockResolvedValue(undefined),
    onUploadFolders: vi.fn().mockResolvedValue(undefined),
    onEditPermissions: vi.fn(),
    onProperties: vi.fn(),
    onToggleBookmark: vi.fn(),
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onToggleBatchMode: vi.fn(),
    onCopyCurrentDirectoryPath: vi.fn().mockResolvedValue(undefined),
    setCreateMode: vi.fn(),
    setRenameTarget: vi.fn(),
    setPermissionsTarget: vi.fn(),
    setPropertiesTarget: vi.fn(),
    setPreviewContent: vi.fn(),
    setUploadConflict: vi.fn(),
    handleCreate: vi.fn().mockResolvedValue(undefined),
    handleRename: vi.fn().mockResolvedValue(undefined),
    handlePermissions: vi.fn().mockResolvedValue(undefined),
  };
  return { ...base, ...overrides };
}

describe('SftpContent system drop', () => {
  beforeEach(() => {
    useSftpStore.setState(initialState, true);
  });

  it('uploads when dropped paths are routed to remote side', async () => {
    const { useSystemFileDrop } = await import('@/hooks/useSystemFileDrop');
    const { useSftpPaneActions } = await import('@/hooks/useSftpPaneActions');
    const { SftpContent } = await import('../index');

    const uploadWithPolicies = vi.fn().mockResolvedValue(undefined);
    const copyWithPolicies = vi.fn().mockResolvedValue(undefined);
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;

    vi.mocked(useSystemFileDrop).mockImplementation(({ onDrop }: UseSystemFileDropOptions) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });

    vi.mocked(useSftpPaneActions).mockReturnValue(
      createActions({ uploadWithPolicies, copyWithPolicies }),
    );

    createConnection();
    const connection = useSftpStore.getState().connections[0]!;

    render(
      <SftpContent
        connection={connection}
        newConnectionMenuOpen={false}
        setNewConnectionMenuOpen={vi.fn()}
        tabContextMenu={null}
        setTabContextMenu={vi.fn()}
        openSftpConnection={vi.fn().mockResolvedValue(undefined)}
        verifyHostKey={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    capturedOnDrop!(['/local/file.txt'], 'remote');
    await waitFor(() => expect(uploadWithPolicies).toHaveBeenCalledWith(['/local/file.txt'], '/remote', []));
    expect(copyWithPolicies).not.toHaveBeenCalled();
  });

  it('copies locally when dropped paths are routed to local side', async () => {
    const { useSystemFileDrop } = await import('@/hooks/useSystemFileDrop');
    const { useSftpPaneActions } = await import('@/hooks/useSftpPaneActions');
    const { SftpContent } = await import('../index');

    const uploadWithPolicies = vi.fn().mockResolvedValue(undefined);
    const copyWithPolicies = vi.fn().mockResolvedValue(undefined);
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;

    vi.mocked(useSystemFileDrop).mockImplementation(({ onDrop }: UseSystemFileDropOptions) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });

    vi.mocked(useSftpPaneActions).mockReturnValue(
      createActions({ uploadWithPolicies, copyWithPolicies }),
    );

    createConnection();
    const connection = useSftpStore.getState().connections[0]!;

    render(
      <SftpContent
        connection={connection}
        newConnectionMenuOpen={false}
        setNewConnectionMenuOpen={vi.fn()}
        tabContextMenu={null}
        setTabContextMenu={vi.fn()}
        openSftpConnection={vi.fn().mockResolvedValue(undefined)}
        verifyHostKey={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    capturedOnDrop!(['/remote/file.txt'], 'local');
    await waitFor(() => expect(copyWithPolicies).toHaveBeenCalledWith(['/remote/file.txt'], '/local', []));
    expect(uploadWithPolicies).not.toHaveBeenCalled();
  });
});
