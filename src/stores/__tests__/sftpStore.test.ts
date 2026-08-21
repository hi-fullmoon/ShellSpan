import { describe, expect, it, beforeEach, vi } from 'vitest';
import { getSftpPaneConnectionKey, useSftpStore } from '../sftpStore';
import { runPathOperation, useTransferStore } from '../transferStore';
import { invokeAddSftpBookmark, invokeDisconnectSftp, invokeRemoveSftpBookmark } from '@/lib/tauri';

vi.mock('@/lib/tauri', () => ({
  invokeListSftpBookmarks: vi.fn().mockResolvedValue([]),
  invokeAddSftpBookmark: vi.fn().mockResolvedValue(undefined),
  invokeRemoveSftpBookmark: vi.fn().mockResolvedValue(undefined),
  invokeDisconnectSftp: vi.fn().mockResolvedValue(undefined),
}));

const initialState = useSftpStore.getState();

describe('sftpStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSftpStore.setState(initialState, true);
    useTransferStore.setState({ operations: [] });
  });

  const baseConnection = {
    id: 'c1',
    title: 'Test',
    connection: {
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'password' as const,
    },
    localPath: '',
    remotePath: '',
    localEntries: [],
    remoteEntries: [],
    localLoading: false,
    remoteLoading: false,
  };

  it('adds a connection and marks it active', () => {
    useSftpStore.getState().addConnection(
      {
        sessionId: 'c1',
        title: 'Test',
        host: 'h',
        port: 22,
        username: 'u',
      },
      baseConnection.connection,
    );
    const state = useSftpStore.getState();
    expect(state.connections).toHaveLength(1);
    expect(state.connections[0]?.sessionId).toBe('c1');
    expect(state.connections[0]?.title).toBe('Test');
    expect(state.activeConnectionId).toBe(state.connections[0]?.id);
  });

  it('sets path and entries', () => {
    useSftpStore.getState().addConnection(
      {
        sessionId: 'c1',
        title: 'Test',
        host: 'h',
        port: 22,
        username: 'u',
      },
      baseConnection.connection,
    );
    const id = useSftpStore.getState().connections[0]?.id ?? '';
    useSftpStore.getState().setPath(id, 'remote', '/home');
    useSftpStore.getState().setEntries(id, 'remote', [
      {
        path: '/home/file.txt',
        name: 'file.txt',
        kind: 'file',
        size: 100,
      },
    ]);
    const state = useSftpStore.getState();
    expect(state.connections[0]?.remotePath).toBe('/home');
    expect(state.connections[0]?.remoteEntries).toHaveLength(1);
  });

  it('opens locally first and attaches a remote connection later', () => {
    useSftpStore.getState().addLocalConnection();
    const local = useSftpStore.getState().connections[0]!;

    expect(local.localOnly).toBe(true);
    expect(local.rightLocal).toBe(false);
    expect(useSftpStore.getState().activeConnectionId).toBe(local.id);

    useSftpStore.getState().setPaneLocal(local.id, 'remote');
    expect(useSftpStore.getState().connections[0]?.rightSource).toBe('local');

    useSftpStore.getState().attachRemoteConnection(
      local.id,
      'remote',
      {
        sessionId: 'remote-session',
        title: 'Production',
        host: 'prod.example.com',
        port: 22,
        username: 'deploy',
      },
      {
        host: 'prod.example.com',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
      },
      'profile-1',
    );

    const attached = useSftpStore.getState().connections[0]!;
    expect(attached.localOnly).toBe(false);
    expect(attached.title).toBe('Production');
    expect(attached.connection.host).toBe('prod.example.com');

    useSftpStore.getState().attachRemoteConnection(
      local.id,
      'local',
      {
        sessionId: 'left-remote-session',
        title: 'Staging',
        host: 'staging.example.com',
        port: 22,
        username: 'deploy',
      },
      {
        host: 'staging.example.com',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
      },
      'profile-2',
    );

    const dualRemote = useSftpStore.getState().connections[0]!;
    expect(dualRemote.leftSource).toBe('remote');
    expect(dualRemote.rightSource).toBe('remote');
    expect(dualRemote.leftTitle).toBe('Staging');
    expect(dualRemote.leftConnection?.host).toBe('staging.example.com');
  });

  it('inserts a duplicated connection after the source tab', () => {
    useSftpStore.getState().addConnection(
      {
        sessionId: 'c1',
        title: 'First',
        host: 'h',
        port: 22,
        username: 'u',
      },
      baseConnection.connection,
      'profile-1',
    );
    const firstId = useSftpStore.getState().connections[0]!.id;

    useSftpStore.getState().addConnection(
      {
        sessionId: 'c2',
        title: 'Second',
        host: 'h',
        port: 22,
        username: 'u',
      },
      baseConnection.connection,
      'profile-1',
    );

    useSftpStore.getState().addConnection(
      {
        sessionId: 'c3',
        title: 'Duplicate',
        host: 'h',
        port: 22,
        username: 'u',
      },
      baseConnection.connection,
      'profile-1',
      { insertAfterId: firstId, pinned: true },
    );

    const titles = useSftpStore.getState().connections.map((c) => c.title);
    expect(titles).toEqual(['First', 'Duplicate', 'Second']);
    expect(useSftpStore.getState().connections[1]?.pinned).toBe(true);
  });

  it('keeps bookmarks isolated between remote panes', () => {
    useSftpStore.getState().addConnection(
      {
        sessionId: 'c1',
        title: 'Right',
        host: 'right.example.com',
        port: 22,
        username: 'u',
      },
      { ...baseConnection.connection, host: 'right.example.com' },
    );
    const id = useSftpStore.getState().connections[0]!.id;

    useSftpStore.getState().addRemoteBookmark(id, 'local', '/left-only');
    useSftpStore.getState().addRemoteBookmark(id, 'remote', '/right-only');

    expect(useSftpStore.getState().connections[0]?.remoteBookmarks).toEqual({
      local: ['/left-only'],
      remote: ['/right-only'],
    });
  });

  it('persists bookmarks with the pane-specific connection key in dual-remote mode', () => {
    useSftpStore.getState().addConnection(
      {
        sessionId: 'c1',
        title: 'Right',
        host: 'right.example.com',
        port: 22,
        username: 'u',
      },
      { ...baseConnection.connection, host: 'right.example.com' },
    );
    const id = useSftpStore.getState().connections[0]!.id;

    useSftpStore.getState().attachRemoteConnection(
      id,
      'local',
      {
        sessionId: 'left-session',
        title: 'Left',
        host: 'left.example.com',
        port: 2222,
        username: 'deploy',
      },
      {
        host: 'left.example.com',
        port: 2222,
        username: 'deploy',
        authMethod: 'password',
      },
      'profile-left',
    );

    useSftpStore.getState().addRemoteBookmark(id, 'local', '/left');
    expect(invokeAddSftpBookmark).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'left.example.com:2222:deploy:local:/left',
        host: 'left.example.com',
        port: 2222,
        username: 'deploy',
      }),
    );

    useSftpStore.getState().removeRemoteBookmark(id, 'local', '/left');
    expect(invokeRemoveSftpBookmark).toHaveBeenCalledWith(
      'left.example.com:2222:deploy:local:/left',
    );

    useSftpStore.getState().addRemoteBookmark(id, 'remote', '/right');
    expect(invokeAddSftpBookmark).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'right.example.com:22:u:remote:/right',
      }),
    );
  });

  it('stores the local clipboard at the store root', () => {
    expect(useSftpStore.getState().localClipboard).toEqual([]);

    const entries = [
      { path: '/local/a.txt', name: 'a.txt', kind: 'file' as const, size: 10 },
    ];
    useSftpStore.getState().setLocalClipboard(entries);
    expect(useSftpStore.getState().localClipboard).toEqual(entries);

    useSftpStore.getState().setLocalClipboard([]);
    expect(useSftpStore.getState().localClipboard).toEqual([]);
  });

  it('keeps pinned tabs inside the pinned group when reordering', () => {
    const summary = (sessionId: string) => ({
      sessionId,
      title: sessionId,
      host: 'h',
      port: 22,
      username: 'u',
    });
    useSftpStore.getState().addConnection(summary('a'), baseConnection.connection);
    useSftpStore.getState().addConnection(summary('b'), baseConnection.connection);
    useSftpStore.getState().addConnection(summary('c'), baseConnection.connection);
    const [a, b, c] = useSftpStore.getState().connections.map((conn) => conn.id);

    useSftpStore.getState().togglePin(a!);
    useSftpStore.getState().togglePin(b!);

    // Dragging a pinned tab past the pinned group clamps it to the group's end.
    useSftpStore.getState().reorderConnections(a!, 5);
    expect(useSftpStore.getState().connections.map((conn) => conn.id)).toEqual([b, a, c]);

    // Dragging an unpinned tab into the pinned group clamps it to the first
    // unpinned slot.
    useSftpStore.getState().reorderConnections(c!, 0);
    expect(useSftpStore.getState().connections.map((conn) => conn.id)).toEqual([b, a, c]);
  });

  it('keeps the left remote title on the tab when the right pane switches to local', () => {
    useSftpStore.getState().addLocalConnection();
    const id = useSftpStore.getState().connections[0]!.id;

    useSftpStore.getState().attachRemoteConnection(
      id,
      'remote',
      {
        sessionId: 'right-session',
        title: 'Production',
        host: 'prod.example.com',
        port: 22,
        username: 'deploy',
      },
      {
        host: 'prod.example.com',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
      },
      'profile-1',
    );
    useSftpStore.getState().attachRemoteConnection(
      id,
      'local',
      {
        sessionId: 'left-session',
        title: 'Staging',
        host: 'staging.example.com',
        port: 22,
        username: 'deploy',
      },
      {
        host: 'staging.example.com',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
      },
      'profile-2',
    );

    useSftpStore.getState().setPaneLocal(id, 'remote');
    let connection = useSftpStore.getState().connections[0]!;
    expect(connection.rightSource).toBe('local');
    expect(connection.title).toBe('Staging');

    // With no remote pane left the tab falls back to the local title.
    useSftpStore.getState().setPaneLocal(id, 'local');
    connection = useSftpStore.getState().connections[0]!;
    expect(connection.title).toBe('Local');
  });

  it('disconnects each distinct remote pane connection when closing a tab', () => {
    useSftpStore.getState().addConnection(
      {
        sessionId: 'c1',
        title: 'Right',
        host: 'right.example.com',
        port: 22,
        username: 'u',
      },
      { host: 'right.example.com', port: 22, username: 'u', authMethod: 'password' },
    );
    const id = useSftpStore.getState().connections[0]!.id;
    useSftpStore.getState().attachRemoteConnection(
      id,
      'local',
      {
        sessionId: 'left-session',
        title: 'Left',
        host: 'left.example.com',
        port: 2222,
        username: 'deploy',
      },
      { host: 'left.example.com', port: 2222, username: 'deploy', authMethod: 'password' },
    );

    useSftpStore.getState().removeConnection(id);

    expect(invokeDisconnectSftp).toHaveBeenCalledTimes(2);
    expect(invokeDisconnectSftp).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'right.example.com', port: 22 }),
    );
    expect(invokeDisconnectSftp).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'left.example.com', port: 2222 }),
    );
  });

  it('disconnects a shared remote connection only once when both panes use it', () => {
    useSftpStore.getState().addConnection(
      {
        sessionId: 'c1',
        title: 'Test',
        host: 'h',
        port: 22,
        username: 'u',
      },
      baseConnection.connection,
    );
    const id = useSftpStore.getState().connections[0]!.id;
    useSftpStore.getState().attachRemoteConnection(
      id,
      'local',
      {
        sessionId: 'left-session',
        title: 'Test',
        host: 'h',
        port: 22,
        username: 'u',
      },
      baseConnection.connection,
    );

    useSftpStore.getState().removeConnection(id);

    expect(invokeDisconnectSftp).toHaveBeenCalledTimes(1);
    expect(invokeDisconnectSftp).toHaveBeenCalledWith(baseConnection.connection);
  });

  it('leaves the pooled connection to the backend TTL while a transfer is active', () => {
    useSftpStore.getState().addConnection(
      {
        sessionId: 'c1',
        title: 'Test',
        host: 'h',
        port: 22,
        username: 'u',
      },
      baseConnection.connection,
    );
    const id = useSftpStore.getState().connections[0]!.id;
    const connection = useSftpStore.getState().connections[0]!;
    useTransferStore.getState().addOperation({
      operationId: 'download-1',
      kind: 'download',
      connectionId: getSftpPaneConnectionKey(connection, 'remote'),
      paths: ['/remote/archive'],
      totalBytes: 100,
      processedBytes: 0,
      totalSteps: 1,
      completedSteps: 0,
      status: 'running',
    });

    useSftpStore.getState().removeConnection(id);

    expect(invokeDisconnectSftp).not.toHaveBeenCalled();
    expect(useSftpStore.getState().connections).toHaveLength(0);
  });

  it('cancels unstarted path tasks owned by a closing tab', async () => {
    useSftpStore.getState().addConnection(
      {
        sessionId: 'c1',
        title: 'Test',
        host: 'h',
        port: 22,
        username: 'u',
      },
      baseConnection.connection,
    );
    const connection = useSftpStore.getState().connections[0]!;
    const connectionKey = getSftpPaneConnectionKey(connection, 'remote');
    useTransferStore.getState().addOperation({
      operationId: 'blocking-transfer',
      kind: 'download',
      connectionId: connectionKey,
      paths: ['/remote/file.txt'],
      totalBytes: 100,
      processedBytes: 0,
      totalSteps: 1,
      completedSteps: 0,
      status: 'running',
    });
    const task = vi.fn().mockResolvedValue(undefined);
    const queued = runPathOperation(
      [{ connectionId: connectionKey, paths: ['/remote/file.txt'] }],
      task,
      { ownerId: connection.id },
    );

    useSftpStore.getState().removeConnection(connection.id);
    useTransferStore.getState().markOperationCompleted('blocking-transfer');
    await queued;

    expect(task).not.toHaveBeenCalled();
  });
});
