import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSftpPaneActions } from '@/hooks/useSftpPaneActions';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';

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
  invokePickLocalFiles: vi.fn().mockResolvedValue([]),
  invokePickLocalFolder: vi.fn().mockResolvedValue([]),
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
  return connection;
}

describe('useSftpPaneActions', () => {
  beforeEach(() => {
    useSftpStore.setState(initialState, true);
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
    });
  });
});
