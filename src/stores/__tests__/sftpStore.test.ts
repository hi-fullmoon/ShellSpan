import { describe, expect, it, beforeEach } from 'vitest';
import { useSftpStore } from '../sftpStore';

const initialState = useSftpStore.getState();

describe('sftpStore', () => {
  beforeEach(() => {
    useSftpStore.setState(initialState, true);
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
});
