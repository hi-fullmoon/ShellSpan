import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findConnectedTerminalSession,
  insertHostCommandSnippet,
  openHostPath,
  runHostConnectionAction,
  sanitizeHostQuickActions,
  validateHostQuickAction,
} from '@/lib/host-quick-actions';
import { useAppStore } from '@/stores/appStore';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { ConnectionProfile } from '@/types';

const { invokeWriteSession } = vi.hoisted(() => ({
  invokeWriteSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tauri', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tauri')>()),
  invokeWriteSession,
}));

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Production',
  host: 'prod.example.test',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  createdAt: 1,
  updatedAt: 1,
};

describe('host quick actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({
      activeSection: 'workbench',
      activeWorkbenchTab: 'connections',
    });
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
    useSftpStore.setState({ connections: [], activeConnectionId: null });
  });

  it('sanitizes persisted metadata and rejects secrets, control characters, and invalid targets', () => {
    expect(sanitizeHostQuickActions([
      {
        id: 'directory-1',
        kind: 'directory',
        label: ' Releases ',
        path: ' /srv/releases ',
        target: 'sftp',
      },
      {
        id: 'command-1',
        kind: 'command',
        label: 'Status',
        command: 'systemctl status api',
      },
      {
        id: 'secret-1',
        kind: 'command',
        label: 'Unsafe',
        command: 'curl --api-key top-secret https://example.test',
      },
      {
        id: 'newline-1',
        kind: 'command',
        label: 'Executes',
        command: 'uptime\r',
      },
      {
        id: 'wrong-target',
        kind: 'directory',
        label: 'Wrong',
        path: '/tmp',
        target: 'browser',
      },
    ])).toEqual([
      {
        id: 'directory-1',
        kind: 'directory',
        label: 'Releases',
        path: '/srv/releases',
        target: 'sftp',
      },
      {
        id: 'command-1',
        kind: 'command',
        label: 'Status',
        command: 'systemctl status api',
      },
    ]);
    expect(validateHostQuickAction({
      id: 'secret-1',
      kind: 'command',
      label: 'Unsafe',
      command: 'password=hunter2',
    })).toBe('possibleSecret');
  });

  it('inserts into a connected terminal for the same profile without sending Enter', async () => {
    useTerminalStore.setState({
      sessions: [
        {
          sessionId: 'wrong-host',
          title: 'Other',
          host: 'other.test',
          port: 22,
          username: 'root',
          status: 'connected',
          profileId: 'profile-2',
        },
        {
          sessionId: 'right-host',
          title: 'Production',
          host: profile.host,
          port: profile.port,
          username: profile.username,
          status: 'connected',
          profileId: profile.id,
        },
      ],
      activeSessionId: 'wrong-host',
    });

    expect(findConnectedTerminalSession(profile.id)).toBe('right-host');
    await expect(insertHostCommandSnippet(profile.id, 'systemctl status api'))
      .resolves.toBe('inserted');

    expect(invokeWriteSession).toHaveBeenCalledWith('right-host', 'systemctl status api');
    expect(invokeWriteSession.mock.calls[0][1]).not.toMatch(/[\r\n]/);
    expect(useTerminalStore.getState().activeSessionId).toBe('right-host');
    expect(useAppStore.getState().activeSection).toBe('terminal');
  });

  it('fails closed when no matching terminal exists or the snippet contains a newline', async () => {
    await expect(insertHostCommandSnippet(profile.id, 'uptime')).resolves.toBe('no-target');
    await expect(insertHostCommandSnippet(profile.id, 'uptime\n')).resolves.toBe('invalid');
    await expect(insertHostCommandSnippet(profile.id, 'password=plaintext')).resolves.toBe('invalid');
    expect(invokeWriteSession).not.toHaveBeenCalled();
  });

  it('opens a path in the already open pane bound to the profile', () => {
    const connection = {
      id: 'sftp-1',
      profileId: profile.id,
      title: profile.name,
      connection: {
        host: profile.host,
        port: profile.port,
        username: profile.username,
        authMethod: profile.authMethod,
      },
    } as SftpConnection;
    useSftpStore.setState({ connections: [connection], activeConnectionId: null });
    const listener = vi.fn();
    document.addEventListener('shellspan:open-sftp-path', listener);

    openHostPath(profile, '/var/log/api', 'sftp');

    expect(useSftpStore.getState().activeConnectionId).toBe('sftp-1');
    expect(useAppStore.getState().activeSection).toBe('sftp');
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      connectionId: 'sftp-1',
      side: 'remote',
      path: '/var/log/api',
    });
    document.removeEventListener('shellspan:open-sftp-path', listener);
  });

  it('creates a host-bound connection when a path has no open pane', () => {
    const listener = vi.fn();
    document.addEventListener('shellspan:connect-profile', listener);

    openHostPath(profile, '/srv/api', 'sftp');

    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      profileId: profile.id,
      target: 'sftp',
      initialDirectory: '/srv/api',
      sftpSide: 'remote',
    });
    document.removeEventListener('shellspan:connect-profile', listener);
  });

  it('routes host tools through the exact profile context', () => {
    const listener = vi.fn();
    document.addEventListener('shellspan:open-host-tool', listener);

    runHostConnectionAction(profile.id, 'portForward');

    expect(useAppStore.getState()).toMatchObject({
      activeSection: 'workbench',
      activeWorkbenchTab: 'connections',
    });
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      profileId: profile.id,
      tool: 'portForward',
    });
    document.removeEventListener('shellspan:open-host-tool', listener);
  });
});
