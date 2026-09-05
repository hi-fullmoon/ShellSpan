import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalDirectory } from '@/hooks/useLocalDirectory';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';

const tauri = vi.hoisted(() => ({
  invokeListLocalDirectory: vi.fn().mockResolvedValue({
    path: '/local',
    entries: [],
  }),
  invokeOpenPath: vi.fn().mockResolvedValue(undefined),
  invokePreviewLocalFile: vi.fn().mockResolvedValue({
    path: '/local/draft.txt',
    name: 'draft.txt',
    content: 'hello',
    size: 5,
    isText: true,
    contentEncoding: 'utf8',
    truncated: false,
  }),
  invokeSupersedeRemoteDirectoryRequest: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/ipc/tauri', () => tauri);

vi.mock('@/lib/error', () => ({
  getLocalizedErrorMessage: vi.fn().mockImplementation((error: unknown) => {
    if (error instanceof Error) return error.message;
    return String(error);
  }),
}));

const file = {
  path: '/local/draft.txt',
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
    remoteEntries: [],
    localLoading: false,
    remoteLoading: false,
    localPane: {
      pathInput: '',
      filterQuery: '',
      selectedPaths: [],
      batchMode: false,
    },
    remotePane: {
      pathInput: '',
      filterQuery: '',
      selectedPaths: [],
      batchMode: false,
    },
    remoteBookmarks: { local: [], remote: [] },
    splitRatio: 0.5,
  };
}

describe('useLocalDirectory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const connection = createConnection();
    useSftpStore.setState({
      connections: [connection],
      activeConnectionId: connection.id,
    });
  });

  it('ignores a stale listing that resolves after a newer one', async () => {
    let resolveStale!: (listing: { path: string; entries: unknown[] }) => void;
    tauri.invokeListLocalDirectory
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveStale = resolve; }),
      )
      .mockResolvedValueOnce({ path: '/new', entries: [file] });

    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useLocalDirectory(connection));

    let staleLoad!: Promise<void>;
    act(() => {
      staleLoad = result.current.loadLocalDirectory('/old');
    });
    await vi.waitFor(() => {
      expect(tauri.invokeListLocalDirectory).toHaveBeenCalledTimes(1);
    });
    await act(() => result.current.loadLocalDirectory('/new'));
    await act(async () => {
      resolveStale({ path: '/old', entries: [] });
      await staleLoad;
    });

    const state = useSftpStore.getState().connections[0]!;
    expect(state.localPath).toBe('/new');
    expect(state.localEntries).toEqual([file]);
    expect(state.localLoading).toBe(false);
    expect(tauri.invokeSupersedeRemoteDirectoryRequest).toHaveBeenCalledTimes(2);
    const [firstKey, firstId] = tauri.invokeSupersedeRemoteDirectoryRequest.mock.calls[0]!;
    const [secondKey, secondId] = tauri.invokeSupersedeRemoteDirectoryRequest.mock.calls[1]!;
    expect(firstKey).toContain(`:${connection.id}:local`);
    expect(secondKey).toBe(firstKey);
    expect(secondId).toBe(firstId + 1);
  });

  it('surfaces listing failures through the pane error state', async () => {
    tauri.invokeListLocalDirectory.mockRejectedValueOnce(
      new Error('permission denied'),
    );

    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useLocalDirectory(connection));

    await act(() => result.current.loadLocalDirectory('/root'));

    const state = useSftpStore.getState().connections[0]!;
    expect(state.localError).toBe('permission denied');
    expect(state.localLoading).toBe(false);
  });

  it('still loads locally if the best-effort remote supersede notification fails', async () => {
    tauri.invokeSupersedeRemoteDirectoryRequest.mockRejectedValueOnce(
      new Error('registry unavailable'),
    );
    tauri.invokeListLocalDirectory.mockResolvedValueOnce({ path: '/local/new', entries: [file] });

    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useLocalDirectory(connection));

    await act(() => result.current.loadLocalDirectory('/local/new'));

    const state = useSftpStore.getState().connections[0]!;
    expect(state.localPath).toBe('/local/new');
    expect(state.localEntries).toEqual([file]);
    expect(state.localError).toBeUndefined();
  });

  it('loads local preview content through the Tauri command', async () => {
    const connection = useSftpStore.getState().connections[0]!;
    const { result } = renderHook(() => useLocalDirectory(connection));

    const preview = await result.current.previewLocalFile('/local/draft.txt');

    expect(tauri.invokePreviewLocalFile).toHaveBeenCalledWith('/local/draft.txt');
    expect(preview.content).toBe('hello');
  });
});
