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
    expect(state.activeConnectionId).toBe('c1');
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
    useSftpStore.getState().setPath('c1', 'remote', '/home');
    useSftpStore.getState().setEntries('c1', 'remote', [
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
});
