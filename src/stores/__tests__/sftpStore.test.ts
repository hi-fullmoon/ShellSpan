import { describe, expect, it, beforeEach, vi } from 'vitest';
import { getSftpPaneConnectionKey, useSftpStore } from '../sftpStore';
import { runPathOperation, useTransferStore } from '../transferStore';
import { invokeAddSftpBookmark, invokeDisconnectSftp, invokeRemoveSftpBookmark } from '@/lib/ipc/tauri';

vi.mock('@/lib/ipc/tauri', () => ({
  buildRemoteConnectionRequest: vi.fn((profile) => ({
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: profile.authMethod,
  })),
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

  it('shows and resolves a pending connection in place', () => {
    const attemptId = useSftpStore.getState().beginConnectionAttempt({
      title: 'Pending server',
      host: 'pending.example.com',
      port: 22,
      username: 'deploy',
      profileId: 'profile-pending',
      connection: {
        host: 'pending.example.com',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
      },
    }, undefined, 'remote', 'attempt-1');

    expect(attemptId).toBe('attempt-1');
    expect(useSftpStore.getState()).toMatchObject({
      activeConnectionId: 'attempt-1',
      connections: [{
        id: 'attempt-1',
        title: 'Pending server',
        pendingConnection: true,
        remoteLoading: true,
        connectionAttemptIds: { remote: 'attempt-1' },
      }],
    });

    const connectionId = useSftpStore.getState().resolveConnectionAttempt(
      attemptId,
      {
        sessionId: 'connected-session',
        title: 'Pending server',
        host: 'pending.example.com',
        port: 22,
        username: 'deploy',
      },
      {
        host: 'pending.example.com',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
        password: 'resolved-secret',
      },
      'profile-pending',
      '/srv/app',
    );

    expect(connectionId).toBe('attempt-1');
    expect(useSftpStore.getState().connections).toHaveLength(1);
    expect(useSftpStore.getState().connections[0]).toMatchObject({
      id: 'attempt-1',
      sessionId: 'connected-session',
      pendingConnection: false,
      remoteLoading: false,
      remotePath: '/srv/app',
      connectionAttemptIds: { remote: undefined },
    });
  });

  it('removes a cancelled new attempt and clears an existing pane attempt', () => {
    const pending = {
      title: 'Pending server',
      host: 'pending.example.com',
      port: 22,
      username: 'deploy',
      profileId: 'profile-pending',
      connection: {
        host: 'pending.example.com',
        port: 22,
        username: 'deploy',
        authMethod: 'password' as const,
      },
    };
    useSftpStore.getState().beginConnectionAttempt(
      pending,
      undefined,
      'remote',
      'new-attempt',
    );
    useSftpStore.getState().endConnectionAttempt('new-attempt');
    expect(useSftpStore.getState().connections).toEqual([]);

    useSftpStore.getState().addConnection(
      {
        sessionId: 'existing-session',
        title: 'Existing server',
        host: 'h',
        port: 22,
        username: 'u',
      },
      baseConnection.connection,
    );
    const existingId = useSftpStore.getState().connections[0]!.id;
    useSftpStore.getState().beginConnectionAttempt(
      pending,
      existingId,
      'local',
      'pane-attempt',
    );
    expect(useSftpStore.getState().connections[0]).toMatchObject({
      localLoading: true,
      connectionAttemptIds: { local: 'pane-attempt' },
    });

    useSftpStore.getState().endConnectionAttempt('pane-attempt');
    expect(useSftpStore.getState().connections).toHaveLength(1);
    expect(useSftpStore.getState().connections[0]).toMatchObject({
      localLoading: false,
      connectionAttemptIds: { local: undefined },
    });
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

  it('restores view state without connecting or restoring transfers', () => {
    useSftpStore.getState().addRestoredConnections([
      {
        id: 'saved-tab',
        title: 'Production',
        pinned: true,
        leftSource: 'local',
        rightSource: 'remote',
        rightProfileId: 'profile-1',
        localPath: 'C:/work',
        remotePath: '/srv/app',
        splitRatio: 0.4,
        remoteBookmarks: { local: [], remote: ['/srv/app'] },
      },
    ], 'saved-tab', [{
      id: 'profile-1',
      name: 'Production',
      host: 'prod.example.com',
      port: 22,
      username: 'alice',
      authMethod: 'password',
      createdAt: 1,
      updatedAt: 1,
    }]);

    const restored = useSftpStore.getState().connections[0]!;
    expect(restored).toMatchObject({
      id: 'saved-tab',
      sessionId: undefined,
      localPath: 'C:/work',
      remotePath: '/srv/app',
      splitRatio: 0.4,
      restorePending: { local: false, remote: true },
    });
    expect(useTransferStore.getState().operations).toEqual([]);

    useSftpStore.getState().attachRemoteConnection(
      restored.id,
      'remote',
      { sessionId: 'connected', title: 'Production', host: 'prod.example.com', port: 22, username: 'alice' },
      baseConnection.connection,
      'profile-1',
    );
    expect(useSftpStore.getState().connections[0]).toMatchObject({
      remotePath: '/srv/app',
      restorePending: { remote: false },
    });
  });

  it('degrades a deleted remote profile to an empty pane', () => {
    useSftpStore.getState().addRestoredConnections([
      {
        id: 'stale-tab',
        title: 'Deleted host',
        pinned: false,
        leftSource: 'local',
        rightSource: 'remote',
        rightProfileId: 'missing',
        localPath: '',
        remotePath: '/srv',
        splitRatio: 0.5,
        remoteBookmarks: { local: [], remote: [] },
      },
    ], 'stale-tab', []);

    expect(useSftpStore.getState().connections[0]).toMatchObject({
      rightSource: 'empty',
      profileId: undefined,
      localOnly: true,
    });
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

  it('keeps the pooled connection alive while another tab uses the same host and disconnects when switching to local', () => {
    useSftpStore.getState().addConnection(
      { sessionId: 'c1', title: 'Tab 1', host: 'h', port: 22, username: 'u' },
      baseConnection.connection,
    );
    useSftpStore.getState().addConnection(
      { sessionId: 'c2', title: 'Tab 2', host: 'h', port: 22, username: 'u' },
      baseConnection.connection,
    );
    const [tab1, tab2] = useSftpStore.getState().connections;

    useSftpStore.getState().removeConnection(tab1!.id);
    expect(invokeDisconnectSftp).not.toHaveBeenCalled();

    useSftpStore.getState().setPaneLocal(tab2!.id, 'remote');
    expect(invokeDisconnectSftp).toHaveBeenCalledTimes(1);
    expect(invokeDisconnectSftp).toHaveBeenCalledWith(baseConnection.connection);
  });

  it('ignores late bookmark hydration results after a pane switches hosts', async () => {
    const { invokeListSftpBookmarks } = await import('@/lib/ipc/tauri');
    let resolveOldBookmarks!: (rows: Array<{ id: string; host: string; port: number; username: string; path: string; side: 'remote'; createdAt: number }>) => void;
    vi.mocked(invokeListSftpBookmarks).mockImplementationOnce(
      () => new Promise((resolve) => { resolveOldBookmarks = resolve; }),
    );
    useSftpStore.getState().addConnection(
      { sessionId: 'c1', title: 'Old', host: 'old.example', port: 22, username: 'u' },
      { host: 'old.example', port: 22, username: 'u', authMethod: 'password' },
    );
    const id = useSftpStore.getState().connections[0]!.id;

    const hydration = useSftpStore.getState().hydrateSftpBookmarks('old.example', 22, 'u', id, 'remote');
    useSftpStore.getState().attachRemoteConnection(
      id,
      'remote',
      { sessionId: 'c2', title: 'New', host: 'new.example', port: 22, username: 'u' },
      { host: 'new.example', port: 22, username: 'u', authMethod: 'password' },
    );

    resolveOldBookmarks([
      { id: 'b1', host: 'old.example', port: 22, username: 'u', path: '/old-only', side: 'remote', createdAt: 1 },
    ]);
    await hydration;

    expect(useSftpStore.getState().connections[0]?.remoteBookmarks.remote).toEqual([]);
  });

  it('disconnects the previous remote host when attachRemoteConnection switches hosts and no other pane uses it', () => {
    const oldRemote = { host: 'old.example', port: 22, username: 'u', authMethod: 'password' as const };
    const newRemote = { host: 'new.example', port: 22, username: 'u', authMethod: 'password' as const };
    useSftpStore.getState().addConnection(
      { sessionId: 'c1', title: 'Tab 1', host: 'old.example', port: 22, username: 'u' },
      oldRemote,
    );
    useSftpStore.getState().addConnection(
      { sessionId: 'c2', title: 'Tab 2', host: 'old.example', port: 22, username: 'u' },
      oldRemote,
    );
    const [tab1, tab2] = useSftpStore.getState().connections;

    useSftpStore.getState().attachRemoteConnection(
      tab1!.id,
      'remote',
      { sessionId: 'c3', title: 'New', host: 'new.example', port: 22, username: 'u' },
      newRemote,
    );
    expect(invokeDisconnectSftp).not.toHaveBeenCalled();

    useSftpStore.getState().attachRemoteConnection(
      tab2!.id,
      'remote',
      { sessionId: 'c4', title: 'New 2', host: 'new.example', port: 22, username: 'u' },
      newRemote,
    );
    expect(invokeDisconnectSftp).toHaveBeenCalledTimes(1);
    expect(invokeDisconnectSftp).toHaveBeenCalledWith(oldRemote);
  });

  it('resets the saved path and bookmarks when switching a restored pane to a different server', () => {
    useSftpStore.getState().addRestoredConnections([
      {
        id: 'restored-tab',
        title: 'Server A',
        pinned: false,
        leftSource: 'remote',
        rightSource: 'remote',
        leftProfileId: 'profile-left',
        rightProfileId: 'profile-a',
        localPath: '/home/admin',
        remotePath: '/xh22sc/H113',
        splitRatio: 0.5,
        remoteBookmarks: { local: ['/home/admin'], remote: ['/xh22sc/H113'] },
      },
    ], 'restored-tab', [
      {
        id: 'profile-left',
        name: 'Left Server',
        host: '175.178.66.45',
        port: 22,
        username: 'admin',
        authMethod: 'password',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'profile-a',
        name: 'Server A',
        host: '172.16.0.101',
        port: 22,
        username: 'xhlis',
        authMethod: 'password',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const serverBRequest = {
      host: '172.16.0.102',
      port: 22,
      username: 'xhlis',
      authMethod: 'password' as const,
    };
    const attemptId = useSftpStore.getState().beginConnectionAttempt({
      title: 'Server B',
      host: serverBRequest.host,
      port: serverBRequest.port,
      username: serverBRequest.username,
      profileId: 'profile-b',
      connection: serverBRequest,
    }, 'restored-tab', 'remote', 'switch-restored');

    useSftpStore.getState().resolveConnectionAttempt(
      attemptId,
      {
        sessionId: 'server-b-session',
        title: 'Server B',
        host: serverBRequest.host,
        port: serverBRequest.port,
        username: serverBRequest.username,
      },
      serverBRequest,
      'profile-b',
    );

    expect(useSftpStore.getState().connections[0]).toMatchObject({
      title: 'Server B',
      profileId: 'profile-b',
      remotePath: '',
      restorePending: { local: true, remote: false },
      remoteBookmarks: { local: ['/home/admin'], remote: [] },
    });

    const serverCRequest = {
      host: '172.16.0.103',
      port: 22,
      username: 'deploy',
      authMethod: 'password' as const,
    };
    useSftpStore.getState().attachRemoteConnection(
      'restored-tab',
      'local',
      {
        sessionId: 'server-c-session',
        title: 'Server C',
        host: serverCRequest.host,
        port: serverCRequest.port,
        username: serverCRequest.username,
      },
      serverCRequest,
      'profile-c',
    );

    expect(useSftpStore.getState().connections[0]).toMatchObject({
      leftTitle: 'Server C',
      leftProfileId: 'profile-c',
      localPath: '',
      restorePending: { local: false, remote: false },
      remoteBookmarks: { local: [], remote: [] },
    });
  });

  it('preserves the saved path and bookmarks when reconnecting the same restored server via connection attempt', () => {
    useSftpStore.getState().addRestoredConnections([
      {
        id: 'restored-same',
        title: 'Server A',
        pinned: false,
        leftSource: 'local',
        rightSource: 'remote',
        rightProfileId: 'profile-a',
        localPath: '',
        remotePath: '/xh22sc/H113',
        splitRatio: 0.5,
        remoteBookmarks: { local: [], remote: ['/xh22sc/H113'] },
      },
    ], 'restored-same', [
      {
        id: 'profile-a',
        name: 'Server A',
        host: '172.16.0.102',
        port: 22,
        username: 'xhlis',
        authMethod: 'password',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);

    const serverARequest = {
      host: '172.16.0.102',
      port: 22,
      username: 'xhlis',
      authMethod: 'password' as const,
    };
    const attemptId = useSftpStore.getState().beginConnectionAttempt({
      title: 'Server A',
      host: serverARequest.host,
      port: serverARequest.port,
      username: serverARequest.username,
      profileId: 'profile-a',
      connection: serverARequest,
    }, 'restored-same', 'remote', 'reconnect-restored');

    useSftpStore.getState().resolveConnectionAttempt(
      attemptId,
      {
        sessionId: 'server-a-session',
        title: 'Server A',
        host: serverARequest.host,
        port: serverARequest.port,
        username: serverARequest.username,
      },
      serverARequest,
      'profile-a',
    );

    expect(useSftpStore.getState().connections[0]).toMatchObject({
      remotePath: '/xh22sc/H113',
      restorePending: { local: false, remote: false },
      remoteBookmarks: { local: [], remote: ['/xh22sc/H113'] },
    });
  });
});
