import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentPermissionStore } from '../agentPermissionStore';
import { useTerminalStore } from '../terminalStore';

const initialTerminalState = useTerminalStore.getState();
const initialPermissionState = useAgentPermissionStore.getState();

function connectSession(
  sessionId: string,
  host = 'server.example.com',
  profileId = 'profile-1',
): void {
  useTerminalStore.getState().addSession({
    sessionId,
    title: sessionId,
    host,
    port: 22,
    username: 'operator',
  }, profileId);
  useTerminalStore.getState().setStatus(sessionId, {
    sessionId,
    status: 'connected',
  });
}

describe('connection-instance Agent permissions', () => {
  beforeEach(() => {
    useTerminalStore.setState(initialTerminalState, true);
    useAgentPermissionStore.setState(initialPermissionState, true);
  });

  it('defaults every new connection to autoApproveReadOnly and isolates identical hosts', () => {
    connectSession('session-a');
    connectSession('session-b');
    const permissions = useAgentPermissionStore.getState();

    expect(permissions.getMode('session-a')).toBe('autoApproveReadOnly');
    expect(permissions.setMode('session-a', 'fullAccess')).toBe(true);
    expect(permissions.getMode('session-a')).toBe('fullAccess');
    expect(permissions.getMode('session-b')).toBe('autoApproveReadOnly');

    useTerminalStore.getState().setActiveSession('session-b');
    expect(useAgentPermissionStore.getState().getMode('session-a')).toBe('fullAccess');
  });

  it.each(['disconnected', 'error'] as const)(
    'resets elevated permission when the connection becomes %s',
    (status) => {
      connectSession('session-a');
      useAgentPermissionStore.getState().setMode('session-a', 'fullAccess');

      useTerminalStore.getState().setStatus('session-a', {
        sessionId: 'session-a',
        status,
      });

      expect(useAgentPermissionStore.getState().getMode('session-a')).toBe('autoApproveReadOnly');
      expect(useAgentPermissionStore.getState().bindings).not.toHaveProperty('session-a');
    },
  );

  it('resets on close and removal', () => {
    connectSession('session-a');
    useAgentPermissionStore.getState().setMode('session-a', 'autoApproveReadOnly');
    useTerminalStore.getState().setClosed('session-a', {
      sessionId: 'session-a',
      reasonKind: 'transport_disconnect',
      retryable: true,
    });
    expect(useAgentPermissionStore.getState().bindings).not.toHaveProperty('session-a');

    connectSession('session-b');
    useAgentPermissionStore.getState().setMode('session-b', 'fullAccess');
    useTerminalStore.getState().removeSession('session-b');
    expect(useAgentPermissionStore.getState().bindings).not.toHaveProperty('session-b');
  });

  it('treats reconnect as a new connection instance with the safe default', () => {
    connectSession('session-old');
    useAgentPermissionStore.getState().setMode('session-old', 'fullAccess');

    useTerminalStore.getState().reconnectSession('session-old', {
      sessionId: 'session-new',
      title: 'replacement',
      host: 'server.example.com',
      port: 22,
      username: 'operator',
    }, 'profile-1');
    useTerminalStore.getState().setStatus('session-new', {
      sessionId: 'session-new',
      status: 'connected',
    });

    expect(useAgentPermissionStore.getState().bindings).not.toHaveProperty('session-old');
    expect(useAgentPermissionStore.getState().getMode('session-new')).toBe('autoApproveReadOnly');
  });

  it('drops a binding if identity changes in place and rejects elevation while disconnected', () => {
    connectSession('session-a');
    useAgentPermissionStore.getState().setMode('session-a', 'fullAccess');
    useTerminalStore.setState((state) => ({
      sessions: state.sessions.map((session) => session.sessionId === 'session-a'
        ? { ...session, username: 'different-user' }
        : session),
    }));

    expect(useAgentPermissionStore.getState().getMode('session-a')).toBe('autoApproveReadOnly');
    useTerminalStore.getState().setStatus('session-a', {
      sessionId: 'session-a',
      status: 'disconnected',
    });
    expect(useAgentPermissionStore.getState().setMode('session-a', 'fullAccess')).toBe(false);
  });
});
