import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSftpPaneActions } from '@/hooks/useSftpPaneActions';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';
import { invokeCopyRemoteToRemote, invokePasteLocalPaths, invokePickLocalFolder, invokeRenameLocalPath, invokeTrashLocalPaths } from '@/lib/tauri';
import { useTransferStore } from '@/stores/transferStore';
import type { ReadRemoteFileResponse } from '@/types';

const connectionMocks = vi.hoisted(() => ({
  deleteRemotePaths: vi.fn().mockResolvedValue(undefined),
  renameRemotePath: vi.fn().mockResolvedValue(undefined),
  downloadRemotePaths: vi.fn().mockResolvedValue(undefined),
  openRemoteFile: vi.fn().mockResolvedValue(undefined),
  previewRemoteFile: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@/hooks/useSftpConnection', () => ({
  useSftpConnection: () => ({
    loadRemoteDirectory: vi.fn().mockResolvedValue(undefined),
    createRemoteEntry: vi.fn().mockResolvedValue(undefined),
    renameRemotePath: connectionMocks.renameRemotePath,
    copyRemotePath: vi.fn().mockResolvedValue(undefined),
    deleteRemotePaths: connectionMocks.deleteRemotePaths,
    updateRemotePermissions: vi.fn().mockResolvedValue(undefined),
    uploadLocalPaths: vi.fn().mockResolvedValue(undefined),
    downloadRemotePaths: connectionMocks.downloadRemotePaths,
    openRemoteFile: connectionMocks.openRemoteFile,
    previewRemoteFile: connectionMocks.previewRemoteFile,
  }),
}));

vi.mock('@/hooks/useLocalDirectory', () => ({
  useLocalDirectory: () => ({
    loadLocalDirectory: vi.fn().mockResolvedValue(undefined),
    openLocalPath: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => toastMocks,
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));

vi.mock('@/hooks/useTransferListeners', () => ({
  useTransferListeners: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  invokeCancelRemoteCopy: vi.fn().mockResolvedValue(undefined),
  invokeCopyLocalPaths: vi.fn().mockResolvedValue(undefined),
  invokeCopyRemoteToRemote: vi.fn().mockResolvedValue(undefined),
  invokePickLocalFiles: vi.fn().mockResolvedValue([]),
  invokePickLocalFolder: vi.fn().mockResolvedValue([]),
  invokeRenameLocalPath: vi.fn().mockResolvedValue(undefined),
  invokeTrashLocalPaths: vi.fn().mockResolvedValue(undefined),
  invokePasteLocalPaths: vi.fn().mockResolvedValue([]),
}));

const initialState = useSftpStore.getState();

function addConnection(): SftpConnection {
  useSftpStore.getState().addConnection(
    {
      sessionId: 'c1',
      title: 'Test',
      host: 'h',
      port: 22,
      username: 'u',
    },
    {
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'password' as const,
    },
  );
  const connection = useSftpStore.getState().connections[0]!;
  useSftpStore.getState().setPath(connection.id, 'remote', '/home');
  useSftpStore.getState().setPath(connection.id, 'local', '/local');
  return useSftpStore.getState().connections[0]!;
}

function responseFor(path: string): ReadRemoteFileResponse {
  return {
    path,
    name: path.split('/').pop() ?? path,
    content: path,
    size: path.length,
    isText: true,
    contentEncoding: 'utf8',
    truncated: false,
  };
}

describe('useSftpPaneActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invokePickLocalFolder).mockResolvedValue([]);
    connectionMocks.downloadRemotePaths.mockResolvedValue(undefined);
    connectionMocks.deleteRemotePaths.mockResolvedValue(undefined);
    connectionMocks.renameRemotePath.mockResolvedValue(undefined);
    connectionMocks.openRemoteFile.mockResolvedValue(undefined);
    connectionMocks.previewRemoteFile.mockResolvedValue({
      path: '/home/test.txt',
      name: 'test.txt',
      content: 'hello',
      size: 5,
      isText: true,
      contentEncoding: 'utf8',
      truncated: false,
    });
    useSftpStore.setState(initialState, true);
    useTransferStore.setState({ operations: [] });
  });

  it('returns expected action handlers and state', () => {
    const connection = addConnection();
    const { result } = renderHook(() => useSftpPaneActions(connection, 'remote'));

    expect(result.current.createMode).toBeNull();
    expect(typeof result.current.onOpen).toBe('function');
    expect(typeof result.current.onNewFile).toBe('function');
    expect(typeof result.current.onToggleBatchMode).toBe('function');
  });

  it('sets create mode when calling onNewFile', () => {
    const connection = addConnection();
    const { result } = renderHook(() => useSftpPaneActions(connection, 'remote'));

    act(() => {
      result.current.onNewFile();
    });

    expect(result.current.createMode).toBe('file');
  });

  it('keeps the newest preview when requests finish out of order', async () => {
    const connection = addConnection();
    const firstEntry = { path: '/home/first.txt', name: 'first.txt', kind: 'file' as const, size: 5 };
    const secondEntry = { path: '/home/second.txt', name: 'second.txt', kind: 'file' as const, size: 6 };
    let resolveFirst!: (value: ReadRemoteFileResponse) => void;
    let resolveSecond!: (value: ReadRemoteFileResponse) => void;
    connectionMocks.previewRemoteFile
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const { result } = renderHook(() => useSftpPaneActions(connection, 'remote'));

    let firstRequest!: Promise<void>;
    let secondRequest!: Promise<void>;
    act(() => {
      firstRequest = result.current.onPreview(firstEntry);
      secondRequest = result.current.onPreview(secondEntry);
    });
    await act(async () => {
      resolveSecond(responseFor('/home/second.txt'));
      await secondRequest;
    });
    expect(result.current.previewContent?.path).toBe('/home/second.txt');

    await act(async () => {
      resolveFirst(responseFor('/home/first.txt'));
      await firstRequest;
    });
    expect(result.current.previewContent?.path).toBe('/home/second.txt');
  });

  it('opens the explicitly supplied preview path instead of the live selection', async () => {
    const connection = addConnection();
    const { result } = renderHook(() => useSftpPaneActions(connection, 'remote'));

    await act(() => result.current.onOpenWithDefaultEditor({ path: '/home/previewed.txt', kind: 'file' }));

    expect(connectionMocks.openRemoteFile).toHaveBeenCalledWith('/home/previewed.txt');
  });

  it('preserves the current selection when entering batch mode', () => {
    const connection = addConnection();
    useSftpStore.getState().setPaneState(connection.id, 'remote', { selectedPaths: ['/home/a'] });
    const updatedConnection = useSftpStore.getState().connections[0]!;

    const { result } = renderHook(() => useSftpPaneActions(updatedConnection, 'remote'));

    act(() => {
      result.current.onToggleBatchMode();
    });

    const pane = useSftpStore.getState().connections[0]?.remotePane;
    expect(pane?.batchMode).toBe(true);
    expect(pane?.selectedPaths).toEqual(['/home/a']);
  });

  it('clears the selection when exiting batch mode', () => {
    const connection = addConnection();
    useSftpStore.getState().setPaneState(connection.id, 'remote', {
      batchMode: true,
      selectedPaths: ['/home/a'],
    });
    const updatedConnection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() =>
      useSftpPaneActions(updatedConnection, 'remote'),
    );

    act(() => {
      result.current.onToggleBatchMode();
    });

    const pane = useSftpStore.getState().connections[0]?.remotePane;
    expect(pane?.batchMode).toBe(false);
    expect(pane?.selectedPaths).toEqual([]);
  });

  it('sets remote clipboard when calling onCopy', () => {
    const connection = addConnection();
    connection.remotePane.selectedPaths = ['/home/test.txt'];
    connection.remoteEntries = [
      {
        path: '/home/test.txt',
        name: 'test.txt',
        kind: 'file',
        size: 100,
      },
    ];

    const { result } = renderHook(() => useSftpPaneActions(connection, 'remote'));

    act(() => {
      result.current.onCopy();
    });

    const clipboard = useSftpStore.getState().connections[0]?.remoteClipboard;
    expect(clipboard).toEqual({
      sourcePath: '/home/test.txt',
      sourceName: 'test.txt',
      kind: 'file',
      sourceSide: 'remote',
      sourceConnection: connection.connection,
      sourceConnectionKey: JSON.stringify(['h', 22, 'u', '', 0, '']),
    });
  });

  it('uses the source connection when pasting across two remote panes', async () => {
    const connection = addConnection();
    useSftpStore.getState().attachRemoteConnection(
      connection.id,
      'local',
      {
        sessionId: 'left',
        title: 'Source',
        host: 'source.example.com',
        port: 22,
        username: 'source-user',
      },
      {
        host: 'source.example.com',
        port: 22,
        username: 'source-user',
        authMethod: 'password',
      },
    );
    useSftpStore.getState().setPath(connection.id, 'local', '/source');
    useSftpStore.getState().setPath(connection.id, 'remote', '/destination');
    useSftpStore.getState().setEntries(connection.id, 'local', [{
      path: '/source/report.txt',
      name: 'report.txt',
      kind: 'file',
      size: 10,
    }]);

    const dualRemote = useSftpStore.getState().connections[0]!;
    const { result: sourceActions } = renderHook(() =>
      useSftpPaneActions(dualRemote, 'local', false),
    );
    act(() => sourceActions.current.onCopy(dualRemote.localEntries[0]));

    const withClipboard = useSftpStore.getState().connections[0]!;
    const { result: destinationActions } = renderHook(() =>
      useSftpPaneActions(withClipboard, 'remote', false),
    );
    await act(() => destinationActions.current.onPaste());

    expect(vi.mocked(invokeCopyRemoteToRemote)).toHaveBeenCalledWith({
      sourceConnection: withClipboard.leftConnection,
      destinationConnection: withClipboard.connection,
      sourcePaths: ['/source/report.txt'],
      destinationDirectory: '/destination',
      conflictPolicies: ['fail'],
      operationId: expect.stringContaining('-remote-copy-'),
    });
    expect(useTransferStore.getState().operations[0]).toMatchObject({
      kind: 'remote-copy',
      completedSteps: 1,
      pathScopes: [
        expect.objectContaining({ paths: ['/source/report.txt'] }),
        expect.objectContaining({ paths: ['/destination/report.txt'] }),
      ],
    });
  });

  function setupCrossServerPaste() {
    const connection = addConnection();
    useSftpStore.getState().attachRemoteConnection(
      connection.id,
      'local',
      {
        sessionId: 'left',
        title: 'Source',
        host: 'source.example.com',
        port: 22,
        username: 'source-user',
      },
      {
        host: 'source.example.com',
        port: 22,
        username: 'source-user',
        authMethod: 'password',
      },
    );
    useSftpStore.getState().setPath(connection.id, 'local', '/source');
    useSftpStore.getState().setPath(connection.id, 'remote', '/destination');
    useSftpStore.getState().setEntries(connection.id, 'local', [{
      path: '/source/report.txt',
      name: 'report.txt',
      kind: 'file',
      size: 10,
    }]);

    const dualRemote = useSftpStore.getState().connections[0]!;
    const { result: sourceActions } = renderHook(() =>
      useSftpPaneActions(dualRemote, 'local', false),
    );
    act(() => sourceActions.current.onCopy(dualRemote.localEntries[0]));

    const withClipboard = useSftpStore.getState().connections[0]!;
    const { result: destinationActions } = renderHook(() =>
      useSftpPaneActions(withClipboard, 'remote', false),
    );
    return destinationActions;
  }

  it('queues paste until the source path operation finishes', async () => {
    const destinationActions = setupCrossServerPaste();
    useTransferStore.getState().addOperation({
      operationId: 'busy-source',
      kind: 'download',
      connectionId: JSON.stringify(['source.example.com', 22, 'source-user', '', 0, '']),
      paths: ['/source/report.txt'],
      totalBytes: 0,
      processedBytes: 0,
      totalSteps: 1,
      completedSteps: 0,
      status: 'running',
    });

    let pastePromise: Promise<void> | undefined;
    await act(async () => {
      pastePromise = destinationActions.current.onPaste();
      await Promise.resolve();
    });
    expect(vi.mocked(invokeCopyRemoteToRemote)).not.toHaveBeenCalled();
    expect(toastMocks.info).toHaveBeenCalledWith('sftp.transfer.queued');

    await act(async () => {
      useTransferStore.getState().markOperationCompleted('busy-source');
    });
    await act(() => pastePromise!);
    expect(vi.mocked(invokeCopyRemoteToRemote)).toHaveBeenCalled();
  });

  it('queues paste until the destination path operation finishes', async () => {
    const destinationActions = setupCrossServerPaste();
    useTransferStore.getState().addOperation({
      operationId: 'busy-destination',
      kind: 'upload',
      connectionId: JSON.stringify(['h', 22, 'u', '', 0, '']),
      paths: ['/destination/report.txt'],
      totalBytes: 0,
      processedBytes: 0,
      totalSteps: 1,
      completedSteps: 0,
      status: 'running',
    });

    let pastePromise: Promise<void> | undefined;
    await act(async () => {
      pastePromise = destinationActions.current.onPaste();
      await Promise.resolve();
    });
    expect(vi.mocked(invokeCopyRemoteToRemote)).not.toHaveBeenCalled();

    await act(async () => {
      useTransferStore.getState().markOperationCompleted('busy-destination');
    });
    await act(() => pastePromise!);
    expect(vi.mocked(invokeCopyRemoteToRemote)).toHaveBeenCalled();
  });

  it('surfaces the backend error when a queued paste runs after the source was deleted', async () => {
    const destinationActions = setupCrossServerPaste();
    useTransferStore.getState().addOperation({
      operationId: 'busy-delete',
      kind: 'delete',
      connectionId: JSON.stringify(['source.example.com', 22, 'source-user', '', 0, '']),
      paths: ['/source/report.txt'],
      totalBytes: 0,
      processedBytes: 0,
      totalSteps: 1,
      completedSteps: 0,
      status: 'running',
    });
    vi.mocked(invokeCopyRemoteToRemote).mockRejectedValueOnce(
      new Error('No such file'),
    );

    let pastePromise: Promise<void> | undefined;
    await act(async () => {
      pastePromise = destinationActions.current.onPaste();
      await Promise.resolve();
    });

    await act(async () => {
      useTransferStore.getState().markOperationCompleted('busy-delete');
    });
    await act(() => pastePromise!);
    expect(vi.mocked(invokeCopyRemoteToRemote)).toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith('error.pathNotFound');
  });

  it('queues delete until the path operation finishes', async () => {
    const connection = addConnection();
    useSftpStore.getState().setEntries(connection.id, 'remote', [{
      path: '/home/file.txt',
      name: 'file.txt',
      kind: 'file',
      size: 10,
    }]);
    const updated = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpPaneActions(updated, 'remote'));
    useTransferStore.getState().addOperation({
      operationId: 'busy-download',
      kind: 'download',
      connectionId: JSON.stringify(['h', 22, 'u', '', 0, '']),
      paths: ['/home/file.txt'],
      totalBytes: 0,
      processedBytes: 0,
      totalSteps: 1,
      completedSteps: 0,
      status: 'running',
    });

    let deletePromise: Promise<void> | undefined;
    await act(async () => {
      deletePromise = result.current.onDelete([updated.remoteEntries[0]!]);
      await Promise.resolve();
    });
    expect(connectionMocks.deleteRemotePaths).not.toHaveBeenCalled();
    expect(toastMocks.info).toHaveBeenCalledWith('sftp.transfer.queued');

    await act(async () => {
      useTransferStore.getState().markOperationCompleted('busy-download');
    });
    await act(() => deletePromise!);
    expect(connectionMocks.deleteRemotePaths).toHaveBeenCalledWith(['/home/file.txt']);
  });

  it('queues rename until the path operation finishes', async () => {
    const connection = addConnection();
    useSftpStore.getState().setEntries(connection.id, 'remote', [{
      path: '/home/file.txt',
      name: 'file.txt',
      kind: 'file',
      size: 10,
    }]);
    const updated = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpPaneActions(updated, 'remote'));
    useTransferStore.getState().addOperation({
      operationId: 'busy-upload',
      kind: 'upload',
      connectionId: JSON.stringify(['h', 22, 'u', '', 0, '']),
      paths: ['/home/file.txt'],
      totalBytes: 0,
      processedBytes: 0,
      totalSteps: 1,
      completedSteps: 0,
      status: 'running',
    });

    act(() => result.current.onRename(updated.remoteEntries[0]!));
    let renamePromise: Promise<void> | undefined;
    await act(async () => {
      renamePromise = result.current.handleRename('renamed.txt');
      await Promise.resolve();
    });
    expect(connectionMocks.renameRemotePath).not.toHaveBeenCalled();

    await act(async () => {
      useTransferStore.getState().markOperationCompleted('busy-upload');
    });
    await act(() => renamePromise!);
    expect(connectionMocks.renameRemotePath).toHaveBeenCalledWith('/home/file.txt', 'renamed.txt');
  });

  it('surfaces the backend error when a queued download runs after the file was deleted', async () => {
    const connection = addConnection();
    useSftpStore.getState().setEntries(connection.id, 'remote', [{
      path: '/home/file.txt',
      name: 'file.txt',
      kind: 'file',
      size: 10,
    }]);
    const updated = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpPaneActions(updated, 'remote'));
    vi.mocked(invokePickLocalFolder).mockResolvedValue(['/downloads']);
    connectionMocks.downloadRemotePaths.mockRejectedValueOnce(new Error('No such file'));
    useTransferStore.getState().addOperation({
      operationId: 'busy-delete',
      kind: 'delete',
      connectionId: JSON.stringify(['h', 22, 'u', '', 0, '']),
      paths: ['/home/file.txt'],
      totalBytes: 0,
      processedBytes: 0,
      totalSteps: 1,
      completedSteps: 0,
      status: 'running',
    });

    let downloadPromise: Promise<void> | undefined;
    await act(async () => {
      downloadPromise = result.current.onDownload(updated.remoteEntries[0]!);
      await Promise.resolve();
    });
    expect(connectionMocks.downloadRemotePaths).not.toHaveBeenCalled();

    await act(async () => {
      useTransferStore.getState().markOperationCompleted('busy-delete');
    });
    await act(() => downloadPromise!);
    expect(connectionMocks.downloadRemotePaths).toHaveBeenCalledWith(['/home/file.txt'], '/downloads');
    expect(toastMocks.error).toHaveBeenCalledWith('error.pathNotFound');
  });

  it('copies local entries into the local clipboard', async () => {
    const connection = addConnection();
    const localEntry = { path: '/local/a.txt', name: 'a.txt', kind: 'file' as const, size: 10 };

    const { result } = renderHook(() => useSftpPaneActions(connection, 'local', true));
    expect(result.current.hasLocalClipboard).toBe(false);

    await act(async () => result.current.onCopy(localEntry));

    expect(useSftpStore.getState().localClipboard).toEqual([localEntry]);
    expect(result.current.hasLocalClipboard).toBe(true);
  });

  it('shares the local clipboard across hook instances', async () => {
    const firstConnection = addConnection();
    const localEntry = { path: '/local/a.txt', name: 'a.txt', kind: 'file' as const, size: 10 };

    const { result: firstPane } = renderHook(() =>
      useSftpPaneActions(firstConnection, 'local', true),
    );
    const { result: secondPane } = renderHook(() =>
      useSftpPaneActions(firstConnection, 'local', true),
    );
    expect(secondPane.current.hasLocalClipboard).toBe(false);

    await act(async () => firstPane.current.onCopy(localEntry));

    expect(secondPane.current.hasLocalClipboard).toBe(true);
    expect(useSftpStore.getState().localClipboard).toEqual([localEntry]);
  });

  it('pastes local clipboard entries into the current directory', async () => {
    const connection = addConnection();
    connection.localPane.selectedPaths = ['/local/a.txt'];
    connection.localEntries = [
      { path: '/local/a.txt', name: 'a.txt', kind: 'file' as const, size: 10 },
    ];

    const { result } = renderHook(() => useSftpPaneActions(connection, 'local', true));
    await act(async () => result.current.onCopy());
    await act(() => result.current.onPaste());

    expect(vi.mocked(invokePasteLocalPaths)).toHaveBeenCalledWith(
      ['/local/a.txt'],
      '/local',
      expect.any(String),
    );
  });

  it('renames a local entry via the local rename command', async () => {
    const connection = addConnection();
    connection.localPane.selectedPaths = ['/local/a.txt'];
    connection.localEntries = [
      { path: '/local/a.txt', name: 'a.txt', kind: 'file' as const, size: 10 },
    ];

    const { result } = renderHook(() => useSftpPaneActions(connection, 'local', true));
    act(() => result.current.onRename());
    await act(() => result.current.handleRename('b.txt'));

    expect(vi.mocked(invokeRenameLocalPath)).toHaveBeenCalledWith('/local/a.txt', 'b.txt');
    expect(result.current.renameTarget).toBeUndefined();
  });

  it('trashes local entries via the trash command', async () => {
    const connection = addConnection();
    connection.localPane.selectedPaths = ['/local/a.txt', '/local/b.txt'];
    connection.localEntries = [
      { path: '/local/a.txt', name: 'a.txt', kind: 'file' as const, size: 10 },
      { path: '/local/b.txt', name: 'b.txt', kind: 'file' as const, size: 10 },
    ];

    const { result } = renderHook(() => useSftpPaneActions(connection, 'local', true));
    await act(() => result.current.onDelete());

    expect(vi.mocked(invokeTrashLocalPaths)).toHaveBeenCalledWith(['/local/a.txt', '/local/b.txt']);
  });
});
