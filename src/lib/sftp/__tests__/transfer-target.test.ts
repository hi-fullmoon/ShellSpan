import { beforeEach, describe, expect, it } from 'vitest';
import { useSftpStore } from '@/stores/sftpStore';
import { isTransferTargetCurrent } from '../transfer-target';

describe('transfer destination identity', () => {
  beforeEach(() => useSftpStore.setState({ connections: [], activeConnectionId: null }));

  it('allows refresh only for the original host and directory', () => {
    const remote = { host: 'host-a', port: 22, username: 'user', authMethod: 'password' as const };
    useSftpStore.getState().addConnection({ sessionId: 'a', title: 'A', ...remote }, remote);
    const original = useSftpStore.getState().connections[0];
    useSftpStore.getState().setPath(original.id, 'remote', '/original');
    const snapshot = useSftpStore.getState().connections[0];
    expect(isTransferTargetCurrent(snapshot, snapshot, 'remote', '/original')).toBe(true);
    useSftpStore.getState().setPath(original.id, 'remote', '/other');
    expect(isTransferTargetCurrent(snapshot, useSftpStore.getState().connections[0], 'remote', '/original')).toBe(false);
    useSftpStore.getState().attachRemoteConnection(original.id, 'remote', { sessionId: 'b', title: 'B', ...remote, host: 'host-b' }, { ...remote, host: 'host-b' });
    useSftpStore.getState().setPath(original.id, 'remote', '/original');
    expect(isTransferTargetCurrent(snapshot, useSftpStore.getState().connections[0], 'remote', '/original')).toBe(false);
    useSftpStore.getState().setPaneLocal(original.id, 'remote');
    useSftpStore.getState().setPath(original.id, 'remote', '/original');
    expect(isTransferTargetCurrent(snapshot, useSftpStore.getState().connections[0], 'remote', '/original')).toBe(false);
    expect(isTransferTargetCurrent(snapshot, undefined, 'remote', '/original')).toBe(false);
  });
});
