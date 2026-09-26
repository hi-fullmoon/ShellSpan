import { beforeEach, describe, expect, it } from 'vitest';
import { useAgentPermissionStore } from '../agentPermissionStore';
import { parseAiPreferences, useAiSettingsStore } from '../aiSettingsStore';
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
    useAiSettingsStore.setState({ agentPermissionMode: 'autoApproveReadOnly', agentExecutionSurface: 'direct' });
    useTerminalStore.setState(initialTerminalState, true);
    useAgentPermissionStore.setState(initialPermissionState, true);
  });

  it('restores both remembered choices for a new terminal after preferences reload', () => {
    connectSession('session-before');
    useAgentPermissionStore.getState().setMode('session-before', 'fullAccess');
    useAiSettingsStore.getState().setAgentExecutionSurface('boundTerminal');
    const settings = useAiSettingsStore.getState();
    const saved: [string, string][] = [
      ['ai.agentPermissionMode', JSON.stringify(settings.agentPermissionMode)],
      ['ai.agentExecutionSurface', JSON.stringify(settings.agentExecutionSurface)],
    ];
    useTerminalStore.setState(initialTerminalState, true);
    useAgentPermissionStore.setState(initialPermissionState, true);
    useAiSettingsStore.setState(parseAiPreferences(saved));
    connectSession('session-after');
    expect(useAgentPermissionStore.getState().getMode('session-after')).toBe('fullAccess');
    expect(useAgentPermissionStore.getState().getBinding('session-after')).toBeUndefined();
    expect(useAiSettingsStore.getState().agentExecutionSurface).toBe('boundTerminal');
  });

  it('remembers full access only for newly connected terminals', () => {
    connectSession('session-a');
    expect(useAgentPermissionStore.getState().setMode('session-a', 'requestApproval')).toBe(true);
    connectSession('session-b');
    expect(useAgentPermissionStore.getState().getMode('session-b')).toBe('requestApproval');
    expect(useAgentPermissionStore.getState().setMode('session-a', 'fullAccess')).toBe(true);
    expect(useAiSettingsStore.getState().agentPermissionMode).toBe('fullAccess');
    expect(useAgentPermissionStore.getState().getMode('session-b')).toBe('requestApproval');
    connectSession('session-c', 'another.example.com');
    expect(useAgentPermissionStore.getState().getMode('session-c')).toBe('fullAccess');
    useAgentPermissionStore.getState().setMode('session-c', 'requestApproval');
    connectSession('session-d');
    expect(useAgentPermissionStore.getState().getMode('session-d')).toBe('requestApproval');
  });

  it('keeps existing terminal preferences when another terminal changes either setting', () => {
    connectSession('session-a');
    connectSession('session-b');
    useAgentPermissionStore.getState().setMode('session-a', 'requestApproval');
    useAgentPermissionStore.getState().setExecutionSurface('session-a', 'boundTerminal');
    expect(useAgentPermissionStore.getState().getMode('session-b')).toBe('autoApproveReadOnly');
    expect(useAgentPermissionStore.getState().getExecutionSurface('session-b')).toBe('direct');
    connectSession('session-c');
    expect(useAgentPermissionStore.getState().getMode('session-c')).toBe('requestApproval');
    expect(useAgentPermissionStore.getState().getExecutionSurface('session-c')).toBe('boundTerminal');
    useAgentPermissionStore.getState().setMode('session-b', 'autoApproveReadOnly');
    useAgentPermissionStore.getState().setExecutionSurface('session-b', 'direct');
    useTerminalStore.getState().setActiveSession('session-a');
    expect(useAgentPermissionStore.getState().getMode('session-a')).toBe('requestApproval');
    expect(useAgentPermissionStore.getState().getExecutionSurface('session-a')).toBe('boundTerminal');
    expect(useAgentPermissionStore.getState().getExecutionSurface('session-c')).toBe('boundTerminal');
  });

  it('defaults to autoApproveReadOnly until a permission preference is selected', () => {
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

  it('uses the remembered preference after reconnect without reusing the old binding', () => {
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
    expect(useAgentPermissionStore.getState().getMode('session-new')).toBe('fullAccess');
  });

  it('drops a binding if identity changes in place and rejects elevation while disconnected', () => {
    connectSession('session-a');
    useAgentPermissionStore.getState().setMode('session-a', 'fullAccess');
    useTerminalStore.setState((state) => ({
      sessions: state.sessions.map((session) => session.sessionId === 'session-a'
        ? { ...session, username: 'different-user' }
        : session),
    }));

    expect(useAgentPermissionStore.getState().bindings).not.toHaveProperty('session-a');
    useTerminalStore.getState().setStatus('session-a', {
      sessionId: 'session-a',
      status: 'disconnected',
    });
    expect(useAgentPermissionStore.getState().setMode('session-a', 'fullAccess')).toBe(false);
  });
});
