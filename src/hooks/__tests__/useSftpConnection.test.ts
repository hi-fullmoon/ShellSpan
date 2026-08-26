import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSftpConnection } from '@/hooks/useSftpConnection';
import {
  getSftpPaneConnectionKey,
  useSftpStore,
  type SftpConnection,
} from '@/stores/sftpStore';
import { useTransferStore } from '@/stores/transferStore';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { promptForMissingKeychainKey } from '@/lib/keychain-key-prompt';
import { clearDirectoryListingCache } from '@/lib/directory-listing-cache';
import type { ReadRemoteFileResponse } from '@/types';

const tauri = vi.hoisted(() => ({
  buildRemoteConnectionRequest: vi.fn((connection: SftpConnection['connection']) => connection),
  invokeCopyRemotePath: vi.fn().mockResolvedValue(undefined),
  invokeCancelDelete: vi.fn().mockResolvedValue(undefined),
  invokeCancelDownload: vi.fn().mockResolvedValue(undefined),
  invokeCancelRemoteCopy: vi.fn().mockResolvedValue(undefined),
  invokeCancelRemoteFileRead: vi.fn().mockResolvedValue(undefined),
  invokeCancelUpload: vi.fn().mockResolvedValue(undefined),
  invokeCreateRemoteEntry: vi.fn().mockResolvedValue(undefined),
  invokeDeleteRemotePath: vi.fn().mockResolvedValue(undefined),
  invokeDownloadRemotePaths: vi.fn().mockResolvedValue({ items: [] }),
  invokeListRemoteDirectory: vi.fn().mockResolvedValue({
    path: '/remote',
    entries: [],
  }),
  invokeOpenRemoteFile: vi.fn().mockResolvedValue(undefined),
  invokePreviewRemoteFile: vi.fn().mockResolvedValue(undefined),
  invokeRenameRemotePath: vi.fn().mockResolvedValue(undefined),
  invokeResolveRemoteEntryOwners: vi.fn().mockResolvedValue({
    ownerNames: {},
    groupNames: {},
  }),
  invokeUpdateRemotePermissions: vi.fn().mockResolvedValue(undefined),
  invokeUploadLocalPaths: vi.fn().mockResolvedValue({ items: [] }),
}));

vi.mock('@/lib/tauri', () => tauri);

vi.mock('@/lib/keychain-key-prompt', () => ({
  promptForMissingKeychainKey: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/error', () => ({
  classifyError: vi.fn().mockReturnValue({
    category: 'unknown',
    retryable: true,
    messageKey: 'error.operationFailed',
  }),
  getErrorMessage: vi.fn().mockImplementation((error: unknown) => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null && 'payload' in error) {
      const typed = error as { payload?: { message?: string } };
      return typed.payload?.message ?? String(error);
    }
    return String(error);
  }),
  getLocalizedErrorMessage: vi.fn().mockImplementation((error: unknown) => {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    if (typeof error === 'object' && error !== null && 'payload' in error) {
      const typed = error as { payload?: { message?: string } };
      return typed.payload?.message ?? String(error);
    }
    return String(error);
  }),
}));

const file = {
  path: '/remote/draft.txt',
  name: 'draft.txt',
  kind: 'file' as const,
  size: 12,
};

function createConnection(): SftpConnection {
  return {
    id: 'connection-1',
    title: 'Test',
    connection: {
      host: 'example.com',
      port: 22,
      username: 'tester',
      authMethod: 'password',
    },
    localPath: '',
    remotePath: '/remote',
    localEntries: [],
    remoteEntries: [file],
    localLoading: false,
    remoteLoading: false,
    localPane: {
      pathInput: '',
      filterQuery: '',
      selectedPaths: [],
      batchMode: false,
    },
    remotePane: {
      pathInput: '/remote',
      filterQuery: '',
      selectedPaths: [],
      batchMode: false,
    },
    remoteBookmarks: { local: [], remote: [] },
    splitRatio: 0.5,
  };
}

describe('useSftpConnection remote delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const connection = createConnection();
    useSftpStore.setState({
      connections: [connection],
      activeConnectionId: connection.id,
    });
    useTransferStore.setState({ operations: [] });
  });

  it('permanently deletes the file directly', async () => {
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await act(() => result.current.deleteRemotePaths([file.path]));

    expect(tauri.invokeDeleteRemotePath).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: [file.path],
        operationId: expect.stringContaining('-delete-'),
      }),
    );
    expect(useTransferStore.getState().operations[0]).toMatchObject({
      kind: 'delete',
      status: 'completed',
    });
  });

  it('marks a failed delete and retains the error', async () => {
    tauri.invokeDeleteRemotePath.mockRejectedValueOnce(new Error('permission denied'));
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await expect(
      act(() => result.current.deleteRemotePaths([file.path])),
    ).rejects.toThrow('permission denied');

    expect(useTransferStore.getState().operations[0]).toMatchObject({
      kind: 'delete',
      status: 'failed',
      error: 'permission denied',
    });
  });

  it('binds backend cancellation to the delete operation', async () => {
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await act(() => result.current.deleteRemotePaths([file.path]));
    const operation = useTransferStore.getState().operations[0]!;
    expect(operation.cancel).toBeTypeOf('function');

    await act(() => operation.cancel!());
    expect(tauri.invokeCancelDelete).toHaveBeenCalledWith(operation.operationId);
  });
});

describe('useSftpConnection directory listing race', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDirectoryListingCache();
    const connection = createConnection();
    useSftpStore.setState({
      connections: [connection],
      activeConnectionId: connection.id,
    });
    useTransferStore.setState({ operations: [] });
  });

  it('ignores a stale listing that resolves after a newer one', async () => {
    let resolveStale!: (listing: { path: string; entries: unknown[] }) => void;
    tauri.invokeListRemoteDirectory
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveStale = resolve; }),
      )
      .mockResolvedValueOnce({ path: '/new', entries: [file] });

    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    let staleLoad!: Promise<void>;
    act(() => {
      staleLoad = result.current.loadRemoteDirectory('/old');
    });
    await act(() => result.current.loadRemoteDirectory('/new'));
    await act(async () => {
      resolveStale({ path: '/old', entries: [] });
      await staleLoad;
    });

    const state = useSftpStore.getState().connections[0]!;
    expect(state.remotePath).toBe('/new');
    expect(state.remoteEntries).toEqual([file]);
    expect(state.remoteLoading).toBe(false);

    const firstRequest = tauri.invokeListRemoteDirectory.mock.calls[0]![0];
    const secondRequest = tauri.invokeListRemoteDirectory.mock.calls[1]![0];
    expect(firstRequest.requestKey).toBe(secondRequest.requestKey);
    expect(firstRequest.requestKey).toMatch(/:connection-1:remote$/);
    expect(secondRequest.requestId).toBe(firstRequest.requestId + 1);
  });

  it('passes the listing generation to owner lookup and ignores its stale failure', async () => {
    let rejectOwners!: (error: Error) => void;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    tauri.invokeResolveRemoteEntryOwners.mockImplementationOnce(
      () => new Promise((_, reject) => { rejectOwners = reject; }),
    );
    tauri.invokeListRemoteDirectory
      .mockResolvedValueOnce({
        path: '/old',
        entries: [{ ...file, path: '/old/draft.txt', ownerUid: 1000 }],
      })
      .mockResolvedValueOnce({ path: '/new', entries: [file] });

    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await act(() => result.current.loadRemoteDirectory('/old'));
    const listingRequest = tauri.invokeListRemoteDirectory.mock.calls[0]![0];
    expect(tauri.invokeResolveRemoteEntryOwners).toHaveBeenCalledWith(
      expect.objectContaining({
        requestKey: listingRequest.requestKey,
        requestId: listingRequest.requestId,
        ownerIds: [1000],
      }),
    );

    await act(() => result.current.loadRemoteDirectory('/new'));
    await act(async () => {
      rejectOwners(new Error('remote directory request superseded'));
      await Promise.resolve();
    });

    const state = useSftpStore.getState().connections[0]!;
    expect(state.remotePath).toBe('/new');
    expect(state.remoteEntries).toEqual([file]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps cached entries while surfacing the latest revalidation error', async () => {
    tauri.invokeListRemoteDirectory
      .mockResolvedValueOnce({ path: '/cached', entries: [file] })
      .mockRejectedValueOnce(new Error('refresh failed'));

    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await act(() => result.current.loadRemoteDirectory('/cached'));
    await act(() => result.current.loadRemoteDirectory('/cached'));

    const state = useSftpStore.getState().connections[0]!;
    expect(state.remotePath).toBe('/cached');
    expect(state.remoteEntries).toEqual([file]);
    expect(state.remoteError).toBe('refresh failed');
    expect(state.remoteLoading).toBe(false);
  });

  it('does not reuse a pane listing after switching its remote profile', async () => {
    tauri.invokeListRemoteDirectory.mockResolvedValueOnce({
      path: '/shared',
      entries: [file],
    });
    const connection: SftpConnection = {
      ...useSftpStore.getState().connections[0]!,
      profileId: 'profile-one',
    };
    useSftpStore.setState({ connections: [connection] });
    const { result, rerender } = renderHook(
      ({ currentConnection }) => useSftpConnection(currentConnection),
      { initialProps: { currentConnection: connection } },
    );
    await act(() => result.current.loadRemoteDirectory('/shared'));

    const nextConnection: SftpConnection = {
      ...connection,
      profileId: 'profile-two',
      connection: {
        ...connection.connection,
        host: 'other.example.com',
      },
      remotePath: '',
      remoteEntries: [],
    };
    useSftpStore.setState({ connections: [nextConnection] });
    rerender({ currentConnection: nextConnection });
    tauri.invokeListRemoteDirectory.mockRejectedValueOnce(new Error('new host unavailable'));

    await act(() => result.current.loadRemoteDirectory('/shared'));

    expect(useSftpStore.getState().connections[0]).toMatchObject({
      remotePath: '',
      remoteEntries: [],
      remoteError: 'new host unavailable',
    });
  });
});

describe('useSftpConnection uploads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const connection = createConnection();
    useSftpStore.setState({
      connections: [connection],
      activeConnectionId: connection.id,
    });
    useTransferStore.setState({ operations: [] });
    useAppStore.setState({ sftpRetryCount: 0 });
  });

  it('marks a successful upload as completed and generates unique operation ids', async () => {
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await act(() => result.current.uploadLocalPaths(['/local/a.txt'], '/remote'));
    await act(() => result.current.uploadLocalPaths(['/local/b.txt'], '/remote'));

    const operations = useTransferStore.getState().operations;
    expect(operations).toHaveLength(2);
    expect(operations[0]!.operationId).not.toBe(operations[1]!.operationId);
    expect(operations[0]).toMatchObject({
      kind: 'upload',
      completedSteps: 1,
      totalSteps: 1,
      error: undefined,
    });
  });

  it('binds backend cancellation to a running upload', async () => {
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await act(() => result.current.uploadLocalPaths(['/local/a.txt'], '/remote'));
    const operation = useTransferStore.getState().operations[0]!;
    expect(operation.cancel).toBeTypeOf('function');

    await act(() => operation.cancel!());
    expect(tauri.invokeCancelUpload).toHaveBeenCalledWith(operation.operationId);
  });

  it('tracks uploaded target paths instead of locking the whole directory', async () => {
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await act(() =>
      result.current.uploadLocalPaths(
        ['/local/a.txt', 'C:\\Users\\tester\\b.txt'],
        '/remote',
      ),
    );

    expect(useTransferStore.getState().operations[0]).toMatchObject({
      kind: 'upload',
      paths: ['/remote/a.txt', '/remote/b.txt'],
    });
  });

  it('retries only failed upload items from a partial batch result', async () => {
    useAppStore.setState({ sftpRetryCount: 1 });
    tauri.invokeUploadLocalPaths
      .mockResolvedValueOnce({
        items: [
          { sourcePath: '/local/a.txt', destinationPath: '/remote/a.txt', status: 'completed' },
          { sourcePath: '/local/b.txt', status: 'failed', error: 'network hiccup' },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          { sourcePath: '/local/b.txt', destinationPath: '/remote/b.txt', status: 'completed' },
        ],
      });
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await act(() =>
      result.current.uploadLocalPaths(['/local/a.txt', '/local/b.txt'], '/remote'),
    );

    expect(tauri.invokeUploadLocalPaths).toHaveBeenCalledTimes(2);
    expect(tauri.invokeUploadLocalPaths).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        localPaths: ['/local/b.txt'],
      }),
    );
    expect(useTransferStore.getState().operations[0]).toMatchObject({
      kind: 'upload',
      paths: ['/remote/b.txt'],
      status: 'completed',
    });
  });
});

describe('useSftpConnection same-host copy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const connection = createConnection();
    useSftpStore.setState({
      connections: [connection],
      activeConnectionId: connection.id,
    });
    useTransferStore.setState({ operations: [] });
    useAppStore.setState({ sftpRetryCount: 0 });
  });

  it('tracks the copy as a transfer operation with an operation id', async () => {
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await act(() => result.current.copyRemotePath(file.path, '/remote/archive'));

    expect(tauri.invokeCopyRemotePath).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: file.path,
        destinationDirectory: '/remote/archive',
        operationId: expect.stringContaining('-copy-'),
      }),
    );
    expect(useTransferStore.getState().operations[0]).toMatchObject({
      kind: 'remote-copy',
      totalSteps: 1,
      completedSteps: 1,
      error: undefined,
    });
    expect(useTransferStore.getState().operations[0]?.cancel).toBeTypeOf('function');
  });

  it('marks a cancelled same-host copy as cancelled instead of failed', async () => {
    let rejectCopy!: (reason: Error) => void;
    tauri.invokeCopyRemotePath.mockImplementationOnce(
      () => new Promise((_, reject) => { rejectCopy = reject; }),
    );
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));
    const copy = result.current.copyRemotePath(file.path, '/remote/archive');
    const operationId = useTransferStore.getState().operations[0]!.operationId;

    await act(() => useTransferStore.getState().cancelOperation(operationId));
    expect(tauri.invokeCancelRemoteCopy).toHaveBeenCalledWith(operationId);

    rejectCopy(new Error('remote copy cancelled'));
    await act(() => copy);
    expect(useTransferStore.getState().operations[0]?.status).toBe('cancelled');
  });

  it('marks a failed same-host copy and retains the error', async () => {
    tauri.invokeCopyRemotePath.mockRejectedValueOnce(new Error('disk full'));
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await expect(
      act(() => result.current.copyRemotePath(file.path, '/remote/archive')),
    ).rejects.toThrow('disk full');

    expect(useTransferStore.getState().operations[0]).toMatchObject({
      kind: 'remote-copy',
      status: 'failed',
      error: 'disk full',
    });
  });
});

describe('useSftpConnection downloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const connection = createConnection();
    useSftpStore.setState({
      connections: [connection],
      activeConnectionId: connection.id,
    });
    useTransferStore.setState({ operations: [] });
    useAppStore.setState({ sftpRetryCount: 0 });
  });
  it('marks a failed download and retains its affected paths', async () => {
    tauri.invokeDownloadRemotePaths.mockRejectedValueOnce(new Error('offline'));
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await expect(
      act(() => result.current.downloadRemotePaths([file.path], '/downloads')),
    ).rejects.toThrow('offline');

    expect(useTransferStore.getState().operations[0]).toMatchObject({
      kind: 'download',
      connectionId: getSftpPaneConnectionKey(connection, 'remote'),
      paths: [file.path],
      status: 'failed',
      error: 'offline',
    });
  });

  it('binds backend cancellation to a running download', async () => {
    let rejectDownload!: (reason: Error) => void;
    tauri.invokeDownloadRemotePaths.mockImplementationOnce(
      () => new Promise((_, reject) => { rejectDownload = reject; }),
    );
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));
    const download = result.current.downloadRemotePaths([file.path], '/downloads');
    const operationId = useTransferStore.getState().operations[0]!.operationId;

    await act(() => useTransferStore.getState().cancelOperation(operationId));
    expect(tauri.invokeCancelDownload).toHaveBeenCalledWith(operationId);

    rejectDownload(new Error('download cancelled'));
    await act(() => download);
    expect(useTransferStore.getState().operations[0]?.status).toBe('cancelled');
  });

  it('retries only failed download items from a partial batch result', async () => {
    useAppStore.setState({ sftpRetryCount: 1 });
    tauri.invokeDownloadRemotePaths
      .mockResolvedValueOnce({
        items: [
          { sourcePath: '/remote/a.txt', destinationPath: '/downloads/a.txt', status: 'completed' },
          { sourcePath: '/remote/b.txt', status: 'failed', error: 'network hiccup' },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          { sourcePath: '/remote/b.txt', destinationPath: '/downloads/b.txt', status: 'completed' },
        ],
      });
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await act(() =>
      result.current.downloadRemotePaths(['/remote/a.txt', '/remote/b.txt'], '/downloads'),
    );

    expect(tauri.invokeDownloadRemotePaths).toHaveBeenCalledTimes(2);
    expect(tauri.invokeDownloadRemotePaths).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        remotePaths: ['/remote/b.txt'],
      }),
    );
    expect(useTransferStore.getState().operations[0]).toMatchObject({
      kind: 'download',
      paths: ['/remote/b.txt'],
      status: 'completed',
    });
  });
});

describe('useSftpConnection remote file reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const connection = createConnection();
    useSftpStore.setState({
      connections: [connection],
      activeConnectionId: connection.id,
    });
    tauri.invokeOpenRemoteFile.mockResolvedValue(undefined);
    tauri.invokePreviewRemoteFile.mockResolvedValue({
      path: file.path,
      name: file.name,
      content: 'hello',
      size: file.size,
      isText: true,
      contentEncoding: 'utf8',
      truncated: false,
    });
  });

  it('cancels the previous open and gives each request a unique operation id', async () => {
    let resolveFirst!: () => void;
    tauri.invokeOpenRemoteFile
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(undefined);
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    const first = result.current.openRemoteFile('/remote/first.log');
    await act(() => result.current.openRemoteFile('/remote/second.log'));

    const firstRequest = tauri.invokeOpenRemoteFile.mock.calls[0]![0];
    const secondRequest = tauri.invokeOpenRemoteFile.mock.calls[1]![0];
    expect(firstRequest).toMatchObject({
      path: '/remote/first.log',
      operationId: expect.stringContaining('-open-'),
    });
    expect(secondRequest).toMatchObject({
      path: '/remote/second.log',
      operationId: expect.stringContaining('-open-'),
    });
    expect(secondRequest.operationId).not.toBe(firstRequest.operationId);
    expect(tauri.invokeCancelRemoteFileRead).toHaveBeenCalledWith(firstRequest.operationId);

    resolveFirst();
    await act(() => first);
  });

  it('cancels the previous preview and lets close cancel the current preview', async () => {
    let resolveFirst!: (value: ReadRemoteFileResponse) => void;
    let resolveSecond!: (value: ReadRemoteFileResponse) => void;
    tauri.invokePreviewRemoteFile
      .mockImplementationOnce(
        () => new Promise<ReadRemoteFileResponse>((resolve) => { resolveFirst = resolve; }),
      )
      .mockImplementationOnce(
        () => new Promise<ReadRemoteFileResponse>((resolve) => { resolveSecond = resolve; }),
      );
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    const first = result.current.previewRemoteFile('/remote/first.log');
    const second = result.current.previewRemoteFile('/remote/second.log');
    const firstRequest = tauri.invokePreviewRemoteFile.mock.calls[0]![0];
    const secondRequest = tauri.invokePreviewRemoteFile.mock.calls[1]![0];

    expect(tauri.invokeCancelRemoteFileRead).toHaveBeenCalledWith(firstRequest.operationId);
    act(() => result.current.cancelRemoteFilePreview());
    expect(tauri.invokeCancelRemoteFileRead).toHaveBeenCalledWith(secondRequest.operationId);

    resolveFirst({
      path: '/remote/first.log',
      name: 'first.log',
      content: 'first',
      size: 5,
      isText: true,
      contentEncoding: 'utf8',
      truncated: false,
    });
    resolveSecond({
      path: '/remote/second.log',
      name: 'second.log',
      content: 'second',
      size: 6,
      isText: true,
      contentEncoding: 'utf8',
      truncated: false,
    });
    await act(async () => {
      await first;
      await second;
    });
  });

  it('cancels active open and preview operations on unmount', () => {
    tauri.invokeOpenRemoteFile.mockImplementationOnce(() => new Promise<void>(() => undefined));
    tauri.invokePreviewRemoteFile.mockImplementationOnce(
      () => new Promise<ReadRemoteFileResponse>(() => undefined),
    );
    const connection = useSftpStore.getState().connections[0]!;
    const { result, unmount } = renderHook(() => useSftpConnection(connection));

    void result.current.openRemoteFile('/remote/open.log');
    void result.current.previewRemoteFile('/remote/preview.log');
    const openOperationId = tauri.invokeOpenRemoteFile.mock.calls[0]![0].operationId;
    const previewOperationId = tauri.invokePreviewRemoteFile.mock.calls[0]![0].operationId;
    unmount();

    expect(tauri.invokeCancelRemoteFileRead).toHaveBeenCalledWith(openOperationId);
    expect(tauri.invokeCancelRemoteFileRead).toHaveBeenCalledWith(previewOperationId);
  });

  it('cancels active reads when same-endpoint credentials change', () => {
    tauri.invokeOpenRemoteFile.mockImplementationOnce(() => new Promise<void>(() => undefined));
    tauri.invokePreviewRemoteFile.mockImplementationOnce(
      () => new Promise<ReadRemoteFileResponse>(() => undefined),
    );
    const connection = useSftpStore.getState().connections[0]!;
    const { result, rerender } = renderHook(
      ({ currentConnection }) => useSftpConnection(currentConnection),
      { initialProps: { currentConnection: connection } },
    );

    void result.current.openRemoteFile('/remote/open.log');
    void result.current.previewRemoteFile('/remote/preview.log');
    const openOperationId = tauri.invokeOpenRemoteFile.mock.calls[0]![0].operationId;
    const previewOperationId = tauri.invokePreviewRemoteFile.mock.calls[0]![0].operationId;

    rerender({
      currentConnection: {
        ...connection,
        connection: {
          ...connection.connection,
          password: 'rotated-secret',
        },
      },
    });

    expect(tauri.invokeCancelRemoteFileRead).toHaveBeenCalledWith(openOperationId);
    expect(tauri.invokeCancelRemoteFileRead).toHaveBeenCalledWith(previewOperationId);
  });
});

describe('useSftpConnection keychain key recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTransferStore.setState({ operations: [] });
    useAppStore.setState({ sftpRetryCount: 0 });
    vi.mocked(promptForMissingKeychainKey).mockReset();
    vi.mocked(promptForMissingKeychainKey).mockResolvedValue(null);
  });

  it('prompts for replacement key when listing fails due to missing keychain key', async () => {
    const profileId = 'profile-1';
    const keychainConnection: SftpConnection = {
      ...createConnection(),
      profileId,
      connection: {
        host: 'example.com',
        port: 22,
        username: 'tester',
        authMethod: 'key',
        keychainKeyId: 'old-key',
      },
    };
    useProfileStore.setState({
      profiles: [
        {
          id: profileId,
          name: 'Test',
          host: 'example.com',
          port: 22,
          username: 'tester',
          authMethod: 'key',
          keychainKeyId: 'old-key',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    useSftpStore.setState({
      connections: [keychainConnection],
      activeConnectionId: keychainConnection.id,
    });

    const recoveredProfile = {
      ...useProfileStore.getState().profiles[0]!,
      keychainKeyId: 'new-key',
    };
    vi.mocked(promptForMissingKeychainKey).mockResolvedValueOnce(recoveredProfile);
    tauri.invokeListRemoteDirectory
      .mockRejectedValueOnce({ type: 'Other', payload: { message: 'keychain key not found: old-key' } })
      .mockResolvedValueOnce({ path: '/remote', entries: [file] });

    const { result } = renderHook(() => useSftpConnection(keychainConnection));

    await act(() => result.current.loadRemoteDirectory());

    expect(promptForMissingKeychainKey).toHaveBeenCalledWith(
      expect.objectContaining({ id: profileId, keychainKeyId: 'old-key' }),
    );
    expect(tauri.invokeListRemoteDirectory).toHaveBeenCalledTimes(2);
    expect(useSftpStore.getState().connections[0]?.connection.keychainKeyId).toBe('new-key');
    expect(useSftpStore.getState().connections[0]?.remoteEntries).toEqual([file]);
  });

  it('does not prompt, retry, or log when an older missing-key error arrives late', async () => {
    const profileId = 'profile-stale';
    const keychainConnection: SftpConnection = {
      ...createConnection(),
      profileId,
      connection: {
        host: 'example.com',
        port: 22,
        username: 'tester',
        authMethod: 'key',
        keychainKeyId: 'old-key',
      },
    };
    useProfileStore.setState({
      profiles: [
        {
          id: profileId,
          name: 'Test',
          host: 'example.com',
          port: 22,
          username: 'tester',
          authMethod: 'key',
          keychainKeyId: 'old-key',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    useSftpStore.setState({
      connections: [keychainConnection],
      activeConnectionId: keychainConnection.id,
    });
    let rejectStale!: (error: unknown) => void;
    tauri.invokeListRemoteDirectory
      .mockImplementationOnce(
        () => new Promise((_, reject) => { rejectStale = reject; }),
      )
      .mockResolvedValueOnce({ path: '/new', entries: [file] });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = renderHook(() => useSftpConnection(keychainConnection));

    let staleLoad!: Promise<void>;
    act(() => {
      staleLoad = result.current.loadRemoteDirectory('/old');
    });
    await act(() => result.current.loadRemoteDirectory('/new'));
    await act(async () => {
      rejectStale({ type: 'Other', payload: { message: 'keychain key not found: old-key' } });
      await staleLoad;
    });

    expect(promptForMissingKeychainKey).not.toHaveBeenCalled();
    expect(tauri.invokeListRemoteDirectory).toHaveBeenCalledTimes(2);
    expect(errorLog).not.toHaveBeenCalled();
    expect(useSftpStore.getState().connections[0]).toMatchObject({
      remotePath: '/new',
      remoteEntries: [file],
      remoteError: undefined,
      connection: { keychainKeyId: 'old-key' },
    });
    errorLog.mockRestore();
  });

  it('surfaces a failed recovery retry through the pane error state', async () => {
    const profileId = 'profile-1';
    const keychainConnection: SftpConnection = {
      ...createConnection(),
      profileId,
      connection: {
        host: 'example.com',
        port: 22,
        username: 'tester',
        authMethod: 'key',
        keychainKeyId: 'old-key',
      },
    };
    useProfileStore.setState({
      profiles: [
        {
          id: profileId,
          name: 'Test',
          host: 'example.com',
          port: 22,
          username: 'tester',
          authMethod: 'key',
          keychainKeyId: 'old-key',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    useSftpStore.setState({
      connections: [keychainConnection],
      activeConnectionId: keychainConnection.id,
    });

    const recoveredProfile = {
      ...useProfileStore.getState().profiles[0]!,
      keychainKeyId: 'new-key',
    };
    vi.mocked(promptForMissingKeychainKey).mockResolvedValueOnce(recoveredProfile);
    tauri.invokeListRemoteDirectory
      .mockRejectedValueOnce({ type: 'Other', payload: { message: 'keychain key not found: old-key' } })
      .mockRejectedValueOnce(new Error('still broken'));

    const { result } = renderHook(() => useSftpConnection(keychainConnection));

    await act(() => result.current.loadRemoteDirectory());

    const state = useSftpStore.getState().connections[0]!;
    expect(state.remoteError).toBe('still broken');
    expect(state.remoteLoading).toBe(false);
  });
});
