import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const tauri = vi.hoisted(() => ({
  buildRemoteConnectionRequest: vi.fn((connection: SftpConnection['connection']) => connection),
  invokeCopyRemotePath: vi.fn().mockResolvedValue(undefined),
  invokeCancelDelete: vi.fn().mockResolvedValue(undefined),
  invokeCancelDownload: vi.fn().mockResolvedValue(undefined),
  invokeCancelRemoteCopy: vi.fn().mockResolvedValue(undefined),
  invokeCancelUpload: vi.fn().mockResolvedValue(undefined),
  invokeCreateRemoteEntry: vi.fn().mockResolvedValue(undefined),
  invokeDeleteRemotePath: vi.fn().mockResolvedValue(undefined),
  invokeDownloadRemotePaths: vi.fn().mockResolvedValue(undefined),
  invokeListRemoteDirectory: vi.fn().mockResolvedValue({
    path: '/remote',
    entries: [],
  }),
  invokeOpenRemoteFile: vi.fn().mockResolvedValue(undefined),
  invokePreviewRemoteFile: vi.fn().mockResolvedValue(undefined),
  invokeRenameRemotePath: vi.fn().mockResolvedValue(undefined),
  invokeRestoreRemotePath: vi.fn().mockResolvedValue(undefined),
  invokeTrashRemotePath: vi.fn().mockResolvedValue({
    originalPath: '/remote/draft.txt',
    trashPath: '/remote/.termbridge/trash/id-draft.txt',
  }),
  invokeUpdateRemotePermissions: vi.fn().mockResolvedValue(undefined),
  invokeUploadLocalPaths: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tauri', () => tauri);

vi.mock('@/lib/keychain-key-prompt', () => ({
  promptForMissingKeychainKey: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/error', () => ({
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

describe('useSftpConnection delete undo window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const connection = createConnection();
    useSftpStore.setState({
      connections: [connection],
      activeConnectionId: connection.id,
    });
    useTransferStore.setState({ operations: [] });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('moves the file to remote trash immediately', async () => {
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await act(() => result.current.deleteRemotePaths([file.path]));

    expect(tauri.invokeTrashRemotePath).toHaveBeenCalledWith(
      expect.objectContaining({ path: file.path }),
    );
    expect(useTransferStore.getState().operations[0]).toMatchObject({
      kind: 'delete',
      completedSteps: 1,
      totalSteps: 1,
    });
    expect(useTransferStore.getState().operations[0]?.undo).toBeTypeOf('function');
  });

  it('restores the trashed file when undo is used', async () => {
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await act(() => result.current.deleteRemotePaths([file.path]));
    const operationId = useTransferStore.getState().operations[0]!.operationId;
    await act(() => useTransferStore.getState().undoOperation(operationId));

    expect(tauri.invokeRestoreRemotePath).toHaveBeenCalledWith(
      expect.objectContaining({
        originalPath: file.path,
        trashPath: '/remote/.termbridge/trash/id-draft.txt',
      }),
    );
    expect(useTransferStore.getState().operations[0]?.status).toBe('restored');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(tauri.invokeDeleteRemotePath).not.toHaveBeenCalled();
  });

  it('permanently deletes trash when the undo window expires', async () => {
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useSftpConnection(connection));

    await act(() => result.current.deleteRemotePaths([file.path]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(tauri.invokeDeleteRemotePath).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/remote/.termbridge/trash/id-draft.txt',
        operationId: expect.stringContaining('-cleanup-0'),
      }),
    );
    expect(useTransferStore.getState().operations).toHaveLength(0);
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
