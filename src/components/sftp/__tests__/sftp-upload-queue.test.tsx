import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { useSftpStore } from '@/stores/sftpStore';
import { useToastStore } from '@/stores/toastStore';
import { useSystemFileDrop, type UseSystemFileDropOptions } from '@/hooks/useSystemFileDrop';
import { useSftpPaneActions, type UseSftpPaneActionsResult } from '@/hooks/useSftpPaneActions';
import { SftpDndContext, type SftpDndPayload } from '@/components/sftp/sftp-dnd-context';
import { SftpContent } from '../index';

const connectionMocks = vi.hoisted(() => ({
  downloadRemotePaths: vi.fn(),
  loadRemoteDirectory: vi.fn(),
  loadLocalDirectory: vi.fn(),
}));

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
  SftpDndContext: vi.fn(({ children }: { children: React.ReactNode }) => <>{children}</>),
}));

vi.mock('@/hooks/useSftpConnection', () => ({
  useSftpConnection: () => ({
    loadRemoteDirectory: connectionMocks.loadRemoteDirectory,
    downloadRemotePaths: connectionMocks.downloadRemotePaths,
  }),
}));

vi.mock('@/hooks/useLocalDirectory', () => ({
  useLocalDirectory: () => ({
    loadLocalDirectory: connectionMocks.loadLocalDirectory,
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

function createConnection(remoteEntryNames: string[] = []) {
  useSftpStore.getState().addConnection(
    { sessionId: 'c1', title: 'Test', host: 'h', port: 22, username: 'u' },
    { host: 'h', port: 22, username: 'u', authMethod: 'password' },
  );
  const id = useSftpStore.getState().connections[0]!.id;
  useSftpStore.getState().setPath(id, 'local', '/local');
  useSftpStore.getState().setPath(id, 'remote', '/remote');
  useSftpStore.getState().setEntries(
    id,
    'remote',
    remoteEntryNames.map((name) => ({ path: `/remote/${name}`, name, kind: 'file' as const })),
  );
  return useSftpStore.getState().connections[0]!;
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
    hasLocalClipboard: false,
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
    handleCreate: vi.fn().mockResolvedValue(undefined),
    handleRename: vi.fn().mockResolvedValue(undefined),
    handlePermissions: vi.fn().mockResolvedValue(undefined),
  };
  return { ...base, ...overrides };
}

function renderContent(connection: ReturnType<typeof createConnection>) {
  return render(
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
}

function lastDragEnd(): (payload: SftpDndPayload, targetSide: 'local' | 'remote') => void {
  const calls = vi.mocked(SftpDndContext).mock.calls;
  return calls[calls.length - 1]![0].onDragEnd;
}

describe('SftpContent upload queue', () => {
  beforeEach(() => {
    useSftpStore.setState(initialState, true);
    useToastStore.setState({ toasts: [] });
    connectionMocks.downloadRemotePaths.mockReset();
    connectionMocks.loadRemoteDirectory.mockReset();
    connectionMocks.loadRemoteDirectory.mockResolvedValue(undefined);
    connectionMocks.loadLocalDirectory.mockReset();
    connectionMocks.loadLocalDirectory.mockResolvedValue(undefined);
    vi.mocked(SftpDndContext).mockClear();
    vi.mocked(useSystemFileDrop).mockImplementation(() => ({
      dragActive: false,
      hoveredSide: null,
    }));
  });

  it('resolves consecutive conflicts without destroying the queue', async () => {
    const uploadWithPolicies = vi.fn().mockResolvedValue(undefined);
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;

    vi.mocked(useSystemFileDrop).mockImplementation(({ onDrop }: UseSystemFileDropOptions) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });
    vi.mocked(useSftpPaneActions).mockReturnValue(createActions({ uploadWithPolicies }));

    renderContent(createConnection(['a.txt', 'b.txt']));

    await capturedOnDrop!(['/local/a.txt', '/local/b.txt'], 'remote');

    // First conflict is presented.
    expect(await screen.findByTitle('a.txt')).toBeInTheDocument();

    // Resolving the first conflict must surface the second one instead of
    // letting the dialog's onClose wipe the pending queue.
    fireEvent.click(screen.getByRole('button', { name: 'sftp.conflict.overwrite' }));
    expect(await screen.findByTitle('b.txt')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'sftp.conflict.overwrite' }));
    await waitFor(() =>
      expect(uploadWithPolicies).toHaveBeenCalledWith(
        ['/local/a.txt', '/local/b.txt'],
        '/remote',
        ['overwrite', 'overwrite'],
      ),
    );
  });

  it('cancel still aborts the whole batch and releases the queue', async () => {
    const uploadWithPolicies = vi.fn().mockResolvedValue(undefined);
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;

    vi.mocked(useSystemFileDrop).mockImplementation(({ onDrop }: UseSystemFileDropOptions) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });
    vi.mocked(useSftpPaneActions).mockReturnValue(createActions({ uploadWithPolicies }));

    renderContent(createConnection(['a.txt', 'b.txt']));

    await capturedOnDrop!(['/local/a.txt', '/local/b.txt'], 'remote');
    expect(await screen.findByTitle('a.txt')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'sftp.conflict.cancel' }));

    await waitFor(() => expect(screen.queryByTitle('a.txt')).not.toBeInTheDocument());
    expect(uploadWithPolicies).not.toHaveBeenCalled();

    // The queue must be free again: a later drop is processed normally.
    await capturedOnDrop!(['/local/c.txt'], 'remote');
    await waitFor(() =>
      expect(uploadWithPolicies).toHaveBeenCalledWith(['/local/c.txt'], '/remote', ['fail']),
    );
  });

  it('recovers the queue when a remote-to-local download fails', async () => {
    connectionMocks.downloadRemotePaths.mockRejectedValue(new Error('boom'));
    vi.mocked(useSftpPaneActions).mockReturnValue(createActions());

    renderContent(createConnection());

    const onDragEnd = lastDragEnd();
    await onDragEnd(
      {
        side: 'remote',
        entries: [{ path: '/remote/file.txt', name: 'file.txt', kind: 'file' }],
      },
      'local',
    );

    // The failure is surfaced as a toast instead of an unhandled rejection...
    await waitFor(() =>
      expect(
        useToastStore.getState().toasts.some(
          (toast) => toast.message === 'sftp.transfer.downloadFailed' && toast.variant === 'error',
        ),
      ).toBe(true),
    );
    // ...and the directory still refreshes afterwards.
    expect(connectionMocks.loadLocalDirectory).toHaveBeenCalledWith('/local');

    // The queue is released: the next drag runs instead of hitting pathBusy.
    await onDragEnd(
      {
        side: 'remote',
        entries: [{ path: '/remote/other.txt', name: 'other.txt', kind: 'file' }],
      },
      'local',
    );
    await waitFor(() => expect(connectionMocks.downloadRemotePaths).toHaveBeenCalledTimes(2));
    expect(
      useToastStore.getState().toasts.some((toast) => toast.message === 'sftp.transfer.pathBusy'),
    ).toBe(false);
  });

  it('treats a name claimed earlier in the same batch as a conflict', async () => {
    const uploadWithPolicies = vi.fn().mockResolvedValue(undefined);
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;

    vi.mocked(useSystemFileDrop).mockImplementation(({ onDrop }: UseSystemFileDropOptions) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });
    vi.mocked(useSftpPaneActions).mockReturnValue(createActions({ uploadWithPolicies }));

    // The destination is empty, but both dropped files share a basename: the
    // second one must conflict with the first instead of being dispatched
    // with a silent 'fail' policy.
    renderContent(createConnection());

    await capturedOnDrop!(['/local/a.txt', '/other/a.txt'], 'remote');
    expect(await screen.findByTitle('a.txt')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'sftp.conflict.overwrite' }));
    await waitFor(() =>
      expect(uploadWithPolicies).toHaveBeenCalledWith(
        ['/local/a.txt', '/other/a.txt'],
        '/remote',
        ['fail', 'overwrite'],
      ),
    );
  });

  it('judges conflicts against entries refreshed after the queue started', async () => {
    const uploadWithPolicies = vi.fn().mockResolvedValue(undefined);
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;

    vi.mocked(useSystemFileDrop).mockImplementation(({ onDrop }: UseSystemFileDropOptions) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });
    vi.mocked(useSftpPaneActions).mockReturnValue(createActions({ uploadWithPolicies }));

    const connection = createConnection(['a.txt']);
    renderContent(connection);

    await capturedOnDrop!(['/local/a.txt', '/local/b.txt'], 'remote');
    expect(await screen.findByTitle('a.txt')).toBeInTheDocument();

    // b.txt appears in the directory while the first conflict dialog is open.
    useSftpStore.getState().setEntries(connection.id, 'remote', [
      { path: '/remote/a.txt', name: 'a.txt', kind: 'file' },
      { path: '/remote/b.txt', name: 'b.txt', kind: 'file' },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'sftp.conflict.overwrite' }));
    // A stale snapshot would have accepted b.txt with a 'fail' policy;
    // instead the fresh listing surfaces its conflict dialog.
    expect(await screen.findByTitle('b.txt')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'sftp.conflict.overwrite' }));
    await waitFor(() =>
      expect(uploadWithPolicies).toHaveBeenCalledWith(
        ['/local/a.txt', '/local/b.txt'],
        '/remote',
        ['overwrite', 'overwrite'],
      ),
    );
  });
});
