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
}));

vi.mock('@/lib/tauri', () => tauri);

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
    await act(() => result.current.loadLocalDirectory('/new'));
    await act(async () => {
      resolveStale({ path: '/old', entries: [] });
      await staleLoad;
    });

    const state = useSftpStore.getState().connections[0]!;
    expect(state.localPath).toBe('/new');
    expect(state.localEntries).toEqual([file]);
    expect(state.localLoading).toBe(false);
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
});
