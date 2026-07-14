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
});
