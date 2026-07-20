import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSftpPaneActions } from '@/hooks/useSftpPaneActions';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';
import { invokeCopyRemoteToRemote, invokePasteLocalPaths, invokeRenameLocalPath, invokeTrashLocalPaths } from '@/lib/tauri';
import { useTransferStore } from '@/stores/transferStore';

vi.mock('@/hooks/useSftpConnection', () => ({
  useSftpConnection: () => ({
    loadRemoteDirectory: vi.fn().mockResolvedValue(undefined),
    createRemoteEntry: vi.fn().mockResolvedValue(undefined),
    renameRemotePath: vi.fn().mockResolvedValue(undefined),
    copyRemotePath: vi.fn().mockResolvedValue(undefined),
    deleteRemotePaths: vi.fn().mockResolvedValue(undefined),
    updateRemotePermissions: vi.fn().mockResolvedValue(undefined),
    uploadLocalPaths: vi.fn().mockResolvedValue(undefined),
    downloadRemotePaths: vi.fn().mockResolvedValue(undefined),
    openRemoteFile: vi.fn().mockResolvedValue(undefined),
    previewRemoteFile: vi.fn().mockResolvedValue({
      path: '/home/test.txt',
      name: 'test.txt',
      content: 'hello',
      size: 5,
      isText: true,
    }),
  }),
}));

vi.mock('@/hooks/useLocalDirectory', () => ({
  useLocalDirectory: () => ({
    loadLocalDirectory: vi.fn().mockResolvedValue(undefined),
    openLocalPath: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    toast: vi.fn(),
  }),
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

describe('useSftpPaneActions', () => {
  beforeEach(() => {
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

  it('copies local entries into the local clipboard', () => {
    const connection = addConnection();
    const localEntry = { path: '/local/a.txt', name: 'a.txt', kind: 'file' as const, size: 10 };

    const { result } = renderHook(() => useSftpPaneActions(connection, 'local', true));
    expect(result.current.hasLocalClipboard).toBe(false);

    act(() => result.current.onCopy(localEntry));

    expect(result.current.hasLocalClipboard).toBe(true);
  });

  it('pastes local clipboard entries into the current directory', async () => {
    const connection = addConnection();
    connection.localPane.selectedPaths = ['/local/a.txt'];
    connection.localEntries = [
      { path: '/local/a.txt', name: 'a.txt', kind: 'file' as const, size: 10 },
    ];

    const { result } = renderHook(() => useSftpPaneActions(connection, 'local', true));
    act(() => result.current.onCopy());
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
