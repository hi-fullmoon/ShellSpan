import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { useSftpStore } from '@/stores/sftpStore';
import { useToastStore } from '@/stores/toastStore';
import { useTransferStore } from '@/stores/transferStore';
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
    invalidatePaneListingCache: vi.fn(),
  }),
}));

vi.mock('@/hooks/useLocalDirectory', () => ({
  useLocalDirectory: () => ({
    loadLocalDirectory: connectionMocks.loadLocalDirectory,
    openLocalPath: vi.fn().mockResolvedValue(undefined),
    previewLocalFile: vi.fn().mockResolvedValue(undefined),
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

// The conflict dialog shows the conflicting name as plain text, so queries
// must be scoped to the dialog content to avoid matching the file listing.
function queryConflictFileName(name: string): HTMLElement | null {
  const dialog = document.body.querySelector('[data-slot="dialog-content"]');
  if (!dialog) return null;
  return within(dialog as HTMLElement).queryByText(name);
}

async function findConflictFileName(name: string): Promise<HTMLElement> {
  let found: HTMLElement | null = null;
  await waitFor(() => {
    found = queryConflictFileName(name);
    expect(found).not.toBeNull();
  });
  return found!;
}

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
    previewTarget: undefined,
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
    closePreview: vi.fn(),
    handleCreate: vi.fn().mockResolvedValue(undefined),
    handleRename: vi.fn().mockResolvedValue(undefined),
    handlePermissions: vi.fn().mockResolvedValue(undefined),
  };
  return { ...base, ...overrides };
}

function contentElement(connection: ReturnType<typeof createConnection>) {
  return (
    <SftpContent
      key={connection.id}
      connection={connection}
      newConnectionMenuOpen={false}
      setNewConnectionMenuOpen={vi.fn()}
      tabContextMenu={null}
      setTabContextMenu={vi.fn()}
      openSftpConnection={vi.fn().mockResolvedValue(undefined)}
      verifyHostKey={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

function renderContent(connection: ReturnType<typeof createConnection>) {
  return render(contentElement(connection));
}

function lastDragEnd(): (payload: SftpDndPayload, targetSide: 'local' | 'remote') => void {
  const calls = vi.mocked(SftpDndContext).mock.calls;
  return calls[calls.length - 1]![0].onDragEnd;
}

describe('SftpContent upload queue', () => {
  beforeEach(() => {
    useSftpStore.setState(initialState, true);
    useToastStore.setState({ toasts: [] });
    useTransferStore.setState({ operations: [] });
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
    expect(await findConflictFileName('a.txt')).toBeInTheDocument();

    // Resolving the first conflict must surface the second one instead of
    // letting the dialog's onClose wipe the pending queue.
    fireEvent.click(screen.getByRole('button', { name: 'sftp.conflict.overwrite' }));
    expect(await findConflictFileName('b.txt')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'sftp.conflict.overwrite' }));
    await waitFor(() =>
      expect(uploadWithPolicies).toHaveBeenCalledWith(
        ['/local/a.txt', '/local/b.txt'],
        '/remote',
        ['overwrite', 'overwrite'],
        undefined,
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
    expect(await findConflictFileName('a.txt')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'sftp.conflict.cancel' }));

    await waitFor(() => expect(queryConflictFileName('a.txt')).not.toBeInTheDocument());
    expect(uploadWithPolicies).not.toHaveBeenCalled();

    // The queue must be free again: a later drop is processed normally.
    await capturedOnDrop!(['/local/c.txt'], 'remote');
    await waitFor(() =>
      expect(uploadWithPolicies).toHaveBeenCalledWith(['/local/c.txt'], '/remote', ['fail'], undefined),
    );
  });

  it('releases the FIFO chain when the conflict dialog is dismissed with Escape', async () => {
    const uploadWithPolicies = vi.fn().mockResolvedValue(undefined);
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;

    vi.mocked(useSystemFileDrop).mockImplementation(({ onDrop }: UseSystemFileDropOptions) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });
    vi.mocked(useSftpPaneActions).mockReturnValue(createActions({ uploadWithPolicies }));

    renderContent(createConnection(['a.txt']));

    await capturedOnDrop!(['/local/a.txt'], 'remote');
    expect(await findConflictFileName('a.txt')).toBeInTheDocument();
    await capturedOnDrop!(['/local/c.txt'], 'remote');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() =>
      expect(uploadWithPolicies).toHaveBeenCalledWith(
        ['/local/c.txt'],
        '/remote',
        ['fail'],
        expect.any(String),
      ),
    );
    expect(uploadWithPolicies).not.toHaveBeenCalledWith(
      ['/local/a.txt'],
      '/remote',
      expect.anything(),
      expect.anything(),
    );
  });

  it('isolates upload conflicts when switching SFTP tabs', async () => {
    const uploadWithPolicies = vi.fn().mockResolvedValue(undefined);
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;

    vi.mocked(useSystemFileDrop).mockImplementation(({ onDrop }: UseSystemFileDropOptions) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });
    vi.mocked(useSftpPaneActions).mockReturnValue(createActions({ uploadWithPolicies }));

    const first = createConnection(['a.txt']);
    const rendered = renderContent(first);
    await capturedOnDrop!(['/local/a.txt'], 'remote');
    expect(await findConflictFileName('a.txt')).toBeInTheDocument();
    await capturedOnDrop!(['/local/b.txt'], 'remote');

    const second = {
      ...first,
      id: 'second-tab',
      remoteEntries: [],
      remotePane: { ...first.remotePane, selectedPaths: [] },
      localPane: { ...first.localPane, selectedPaths: [] },
    };
    rendered.rerender(contentElement(second));

    await waitFor(() => expect(queryConflictFileName('a.txt')).not.toBeInTheDocument());
    await waitFor(() =>
      expect(
        useTransferStore.getState().operations.every((op) => op.status !== 'pending'),
      ).toBe(true),
    );
    expect(uploadWithPolicies).not.toHaveBeenCalled();
  });

  it('passes the overwrite policy through to remote-to-local downloads', async () => {
    connectionMocks.downloadRemotePaths.mockResolvedValue(undefined);
    vi.mocked(useSftpPaneActions).mockReturnValue(createActions());

    const connection = createConnection();
    useSftpStore.getState().setEntries(connection.id, 'local', [
      { path: '/local/file.txt', name: 'file.txt', kind: 'file' },
    ]);
    renderContent(connection);

    const onDragEnd = lastDragEnd();
    await onDragEnd(
      {
        side: 'remote',
        entries: [{ path: '/remote/file.txt', name: 'file.txt', kind: 'file' }],
      },
      'local',
    );

    expect(await findConflictFileName('file.txt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sftp.conflict.overwrite' }));

    await waitFor(() =>
      expect(connectionMocks.downloadRemotePaths).toHaveBeenCalledWith(
        ['/remote/file.txt'],
        '/local',
        undefined,
        ['overwrite'],
      ),
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

    // The queue is released: the next drag runs instead of being blocked.
    await onDragEnd(
      {
        side: 'remote',
        entries: [{ path: '/remote/other.txt', name: 'other.txt', kind: 'file' }],
      },
      'local',
    );
    await waitFor(() => expect(connectionMocks.downloadRemotePaths).toHaveBeenCalledTimes(2));
  });

  it('queues a drop while another batch waits on a conflict dialog', async () => {
    const uploadWithPolicies = vi.fn().mockResolvedValue(undefined);
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;

    vi.mocked(useSystemFileDrop).mockImplementation(({ onDrop }: UseSystemFileDropOptions) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });
    vi.mocked(useSftpPaneActions).mockReturnValue(createActions({ uploadWithPolicies }));

    renderContent(createConnection(['a.txt']));

    await capturedOnDrop!(['/local/a.txt'], 'remote');
    expect(await findConflictFileName('a.txt')).toBeInTheDocument();

    // A second drop while the conflict dialog is open is queued, not rejected,
    // and shows up as a pending row in the transfer list.
    await capturedOnDrop!(['/local/c.txt'], 'remote');
    expect(uploadWithPolicies).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        useTransferStore.getState().operations.some(
          (op) => op.status === 'pending' && op.currentPath === '/local/c.txt',
        ),
      ).toBe(true),
    );

    // Finishing the first batch releases the queued one; the pending row
    // becomes the real upload operation in place (same operation id).
    fireEvent.click(screen.getByRole('button', { name: 'sftp.conflict.overwrite' }));
    await waitFor(() =>
      expect(uploadWithPolicies).toHaveBeenCalledWith(['/local/a.txt'], '/remote', ['overwrite'], undefined),
    );
    await waitFor(() =>
      expect(uploadWithPolicies).toHaveBeenCalledWith(['/local/c.txt'], '/remote', ['fail'], expect.any(String)),
    );
    await waitFor(() =>
      expect(
        useTransferStore.getState().operations.every((op) => op.status !== 'pending'),
      ).toBe(true),
    );
  });

  // Both the "cancel" link and the row's close (X) button must abort a queued
  // batch; closing the row alone would let it run later.
  it.each([{ buttonName: 'common.cancel' }, { buttonName: 'common.close' }])(
    'cancels a queued batch from the pending transfer row ($buttonName)',
    async ({ buttonName }) => {
    // The first batch stays in flight so the second drop is queued; a conflict
    // dialog would make the transfer list inert (modal), so the cancel must
    // happen while the previous batch is still uploading.
    let resolveFirstUpload!: () => void;
    const firstUpload = new Promise<void>((resolve) => {
      resolveFirstUpload = resolve;
    });
    const uploadWithPolicies = vi.fn().mockImplementation(() => firstUpload);
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;

    vi.mocked(useSystemFileDrop).mockImplementation(({ onDrop }: UseSystemFileDropOptions) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });
    vi.mocked(useSftpPaneActions).mockReturnValue(createActions({ uploadWithPolicies }));

    renderContent(createConnection());

    await capturedOnDrop!(['/local/a.txt'], 'remote');
    await waitFor(() =>
      expect(uploadWithPolicies).toHaveBeenCalledWith(['/local/a.txt'], '/remote', ['fail'], undefined),
    );

    await capturedOnDrop!(['/local/c.txt'], 'remote');
    await waitFor(() =>
      expect(
        useTransferStore.getState().operations.some((op) => op.status === 'pending'),
      ).toBe(true),
    );

    // Cancelling the pending row removes it and drops the queued batch.
    fireEvent.click(await screen.findByRole('button', { name: buttonName }));
    await waitFor(() =>
      expect(
        useTransferStore.getState().operations.every((op) => op.status !== 'pending'),
      ).toBe(true),
    );

    // Finishing the first batch must not run the cancelled one.
    uploadWithPolicies.mockResolvedValue(undefined);
    resolveFirstUpload();
    await waitFor(() =>
      expect(connectionMocks.loadRemoteDirectory).toHaveBeenCalled(),
    );
    expect(uploadWithPolicies).toHaveBeenCalledTimes(1);
    expect(uploadWithPolicies).not.toHaveBeenCalledWith(['/local/c.txt'], '/remote', ['fail']);
    },
  );

  it('cancels queued batches when the SFTP content unmounts', async () => {
    let resolveFirstUpload!: () => void;
    const firstUpload = new Promise<void>((resolve) => {
      resolveFirstUpload = resolve;
    });
    const uploadWithPolicies = vi.fn().mockImplementation(() => firstUpload);
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;

    vi.mocked(useSystemFileDrop).mockImplementation(({ onDrop }: UseSystemFileDropOptions) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });
    vi.mocked(useSftpPaneActions).mockReturnValue(createActions({ uploadWithPolicies }));

    const rendered = renderContent(createConnection());
    await capturedOnDrop!(['/local/a.txt'], 'remote');
    await waitFor(() => expect(uploadWithPolicies).toHaveBeenCalledTimes(1));
    await capturedOnDrop!(['/local/b.txt'], 'remote');
    await waitFor(() =>
      expect(
        useTransferStore.getState().operations.some((op) => op.status === 'pending'),
      ).toBe(true),
    );

    rendered.unmount();
    await waitFor(() =>
      expect(
        useTransferStore.getState().operations.every((op) => op.status !== 'pending'),
      ).toBe(true),
    );

    resolveFirstUpload();
    await Promise.resolve();
    await Promise.resolve();
    expect(uploadWithPolicies).toHaveBeenCalledTimes(1);
  });

  it('lists queued batches newest first', async () => {
    const firstUpload = new Promise<void>(() => {
      // Never settles: the first batch stays in flight for the whole test.
    });
    const uploadWithPolicies = vi.fn().mockImplementation(() => firstUpload);
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;

    vi.mocked(useSystemFileDrop).mockImplementation(({ onDrop }: UseSystemFileDropOptions) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });
    vi.mocked(useSftpPaneActions).mockReturnValue(createActions({ uploadWithPolicies }));

    renderContent(createConnection());

    await capturedOnDrop!(['/local/a.txt'], 'remote');
    await waitFor(() => expect(uploadWithPolicies).toHaveBeenCalled());

    await capturedOnDrop!(['/local/b.txt'], 'remote');
    await capturedOnDrop!(['/local/c.txt'], 'remote');

    // The store prepends new operations and the list renders newest first:
    // the later queued batch sits above the earlier one.
    const rowB = await screen.findByText('b.txt');
    const rowC = await screen.findByText('c.txt');
    expect(
      rowC.compareDocumentPosition(rowB) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps a queued batch in its row when it starts running', async () => {
    let resolveFirstUpload!: () => void;
    const firstUpload = new Promise<void>((resolve) => {
      resolveFirstUpload = resolve;
    });
    const uploadWithPolicies = vi
      .fn()
      .mockImplementationOnce(() => firstUpload)
      .mockImplementation(async (paths: string[], _destination: string, _policies: unknown, operationId?: string) => {
        // Mirror the real hook: the operation reuses the pending row's id.
        useTransferStore.getState().addOperation({
          operationId: operationId ?? 'unexpected-id',
          kind: 'upload',
          currentPath: paths[0],
          totalBytes: 0,
          processedBytes: 0,
          totalSteps: paths.length,
          completedSteps: 0,
          status: 'running',
        });
      });
    let capturedOnDrop: ((paths: string[], side: 'local' | 'remote') => void) | undefined;

    vi.mocked(useSystemFileDrop).mockImplementation(({ onDrop }: UseSystemFileDropOptions) => {
      capturedOnDrop = onDrop;
      return { dragActive: false, hoveredSide: null };
    });
    vi.mocked(useSftpPaneActions).mockReturnValue(createActions({ uploadWithPolicies }));

    renderContent(createConnection());

    await capturedOnDrop!(['/local/a.txt'], 'remote');
    await waitFor(() => expect(uploadWithPolicies).toHaveBeenCalledTimes(1));

    await capturedOnDrop!(['/local/b.txt'], 'remote');
    await capturedOnDrop!(['/local/c.txt'], 'remote');
    await screen.findByText('b.txt');
    await screen.findByText('c.txt');

    resolveFirstUpload();
    await waitFor(() =>
      expect(uploadWithPolicies).toHaveBeenCalledWith(['/local/b.txt'], '/remote', ['fail'], expect.any(String)),
    );
    await waitFor(() =>
      expect(uploadWithPolicies).toHaveBeenCalledWith(['/local/c.txt'], '/remote', ['fail'], expect.any(String)),
    );

    // Both batches turned their pending rows into the real operation: no new
    // row was prepended, so the order (c above b) is unchanged.
    expect(useTransferStore.getState().operations).toHaveLength(2);
    expect(
      useTransferStore.getState().operations.every((op) => op.status === 'running'),
    ).toBe(true);
    const rowB = await screen.findByText('b.txt');
    const rowC = await screen.findByText('c.txt');
    expect(
      rowC.compareDocumentPosition(rowB) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
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
    expect(await findConflictFileName('a.txt')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'sftp.conflict.overwrite' }));
    await waitFor(() =>
      expect(uploadWithPolicies).toHaveBeenCalledWith(
        ['/local/a.txt', '/other/a.txt'],
        '/remote',
        ['fail', 'overwrite'],
        undefined,
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
    expect(await findConflictFileName('a.txt')).toBeInTheDocument();

    // b.txt appears in the directory while the first conflict dialog is open.
    useSftpStore.getState().setEntries(connection.id, 'remote', [
      { path: '/remote/a.txt', name: 'a.txt', kind: 'file' },
      { path: '/remote/b.txt', name: 'b.txt', kind: 'file' },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'sftp.conflict.overwrite' }));
    // A stale snapshot would have accepted b.txt with a 'fail' policy;
    // instead the fresh listing surfaces its conflict dialog.
    expect(await findConflictFileName('b.txt')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'sftp.conflict.overwrite' }));
    await waitFor(() =>
      expect(uploadWithPolicies).toHaveBeenCalledWith(
        ['/local/a.txt', '/local/b.txt'],
        '/remote',
        ['overwrite', 'overwrite'],
        undefined,
      ),
    );
  });
});
