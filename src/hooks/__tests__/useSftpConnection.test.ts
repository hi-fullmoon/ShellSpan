import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSftpConnection } from '@/hooks/useSftpConnection';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';
import { useTransferStore } from '@/stores/transferStore';

const tauri = vi.hoisted(() => ({
  invokeCopyRemotePath: vi.fn().mockResolvedValue(undefined),
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
    trashPath: '/remote/.termbridge-trash/id-draft.txt',
  }),
  invokeUpdateRemotePermissions: vi.fn().mockResolvedValue(undefined),
  invokeUploadLocalPaths: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tauri', () => tauri);

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
    remoteBookmarks: [],
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
        trashPath: '/remote/.termbridge-trash/id-draft.txt',
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
        path: '/remote/.termbridge-trash/id-draft.txt',
        operationId: expect.stringContaining('-cleanup-0'),
      }),
    );
    expect(useTransferStore.getState().operations).toHaveLength(0);
  });
});
