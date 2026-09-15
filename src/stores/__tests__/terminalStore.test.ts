import { describe, expect, it, beforeEach } from 'vitest';
import { useTerminalStore } from '../terminalStore';
import type { TerminalWorkspaceSession } from '../terminalStore';

const initialState = useTerminalStore.getState();

describe('terminalStore', () => {
  beforeEach(() => {
    useTerminalStore.setState(initialState, true);
  });

  it('adds a session and marks it active', () => {
    useTerminalStore.getState().addSession({
      sessionId: 's1',
      title: 'Test',
      host: 'h',
      port: 22,
      username: 'u',
    });
    const state = useTerminalStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.activeSessionId).toBe('s1');
  });

  it('tracks concurrent connection attempts independently', () => {
    const store = useTerminalStore.getState();
    const pending = { title: 'Pending', host: 'h', port: 22, username: 'u' };

    expect(store.beginConnectionAttempt(pending, 'attempt-1')).toBe('attempt-1');
    store.beginConnectionAttempt({ ...pending, title: 'Second' }, 'attempt-2');
    store.beginConnectionAttempt({ ...pending, title: 'Updated' }, 'attempt-1');

    expect(useTerminalStore.getState().sessions).toMatchObject([
      { sessionId: 'attempt-1', title: 'Updated', pendingConnection: true },
      { sessionId: 'attempt-2', title: 'Second', pendingConnection: true },
    ]);

    store.endConnectionAttempt('attempt-1');
    expect(useTerminalStore.getState().sessions).toMatchObject([
      { sessionId: 'attempt-2', pendingConnection: true },
    ]);
  });

  it('replaces a connection placeholder in place with the real session', () => {
    const store = useTerminalStore.getState();
    store.beginConnectionAttempt(
      { title: 'Pending', host: 'h', port: 22, username: 'u', profileId: 'p1' },
      'attempt-1',
    );
    store.resolveConnectionAttempt('attempt-1', {
      sessionId: 's1', title: 'Connected', host: 'h', port: 22, username: 'u',
    }, 'p1');

    expect(useTerminalStore.getState().sessions).toMatchObject([{
      sessionId: 's1',
      title: 'Connected',
      profileId: 'p1',
      status: 'connecting',
      replacesSessionId: 'attempt-1',
    }]);
    expect(useTerminalStore.getState().sessions[0]?.pendingConnection).toBeUndefined();
    expect(useTerminalStore.getState().activeSessionId).toBe('s1');
  });

  it('removes a session and updates active session', () => {
    const store = useTerminalStore.getState();
    store.addSession({
      sessionId: 's1',
      title: 'A',
      host: 'h',
      port: 22,
      username: 'u',
    });
    store.addSession({
      sessionId: 's2',
      title: 'B',
      host: 'h',
      port: 22,
      username: 'u',
    });
    store.removeSession('s1');
    const state = useTerminalStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.activeSessionId).toBe('s2');
  });

  it('updates session status', () => {
    useTerminalStore.getState().addSession({
      sessionId: 's1',
      title: 'Test',
      host: 'h',
      port: 22,
      username: 'u',
    });
    useTerminalStore.getState().setStatus('s1', {
      sessionId: 's1',
      status: 'connected',
      message: 'ok',
    });
    expect(useTerminalStore.getState().sessions[0]?.status).toBe('connected');
  });

  it('accepts only generation-matched ephemeral integration state', () => {
    useTerminalStore.getState().addSession({
      sessionId: 'transport-1',
      terminalSessionId: 'terminal-1',
      terminalGeneration: 2,
      title: 'zsh',
      host: 'local',
      port: 0,
      username: 'user',
    });
    useTerminalStore.getState().setIntegrationState({
      sessionId: 'transport-1',
      terminalSessionId: 'terminal-1',
      terminalGeneration: 1,
      state: 'ready',
    });
    expect(useTerminalStore.getState().sessions[0]?.integrationState).toBeUndefined();

    useTerminalStore.getState().setIntegrationState({
      sessionId: 'transport-1',
      terminalSessionId: 'terminal-1',
      terminalGeneration: 2,
      state: 'degraded',
      reason: 'unsupportedShell',
    });
    expect(useTerminalStore.getState().sessions[0]).toMatchObject({
      integrationState: 'degraded',
      integrationReason: 'unsupportedShell',
    });
  });

  it('reorderSessions moves active to insert index', () => {
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 's1', title: 'A', host: 'h', port: 22, username: 'u' });
    store.addSession({ sessionId: 's2', title: 'B', host: 'h', port: 22, username: 'u' });
    store.addSession({ sessionId: 's3', title: 'C', host: 'h', port: 22, username: 'u' });
    store.reorderSessions('s3', 0);
    const ids = useTerminalStore.getState().sessions.map((s) => s.sessionId);
    expect(ids).toEqual(['s3', 's1', 's2']);
  });

  it('togglePin toggles the pinned state of a session', () => {
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 's1', title: 'A', host: 'h', port: 22, username: 'u' });

    store.togglePin('s1');
    expect(useTerminalStore.getState().sessions[0]?.pinned).toBe(true);

    store.togglePin('s1');
    expect(useTerminalStore.getState().sessions[0]?.pinned).toBe(false);
  });

  it('setTabColor sets and clears the session color', () => {
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 's1', title: 'A', host: 'h', port: 22, username: 'u' });

    store.setTabColor('s1', '#ef4444');
    expect(useTerminalStore.getState().sessions[0]?.color).toBe('#ef4444');

    store.setTabColor('s1', undefined);
    expect(useTerminalStore.getState().sessions[0]?.color).toBeUndefined();
  });

  it('addSession persists profileId when provided', () => {
    useTerminalStore.getState().addSession(
      { sessionId: 's1', title: 'A', host: 'h', port: 22, username: 'u' },
      'profile-1',
    );
    expect(useTerminalStore.getState().sessions[0]?.profileId).toBe('profile-1');
  });

  it('reconnectSession replaces the old session while preserving metadata', () => {
    const store = useTerminalStore.getState();
    store.addSession(
      { sessionId: 's1', title: 'Old', host: 'h', port: 22, username: 'u' },
      'profile-1',
    );
    store.updateTitle('s1', 'Renamed');
    store.togglePin('s1');
    store.setTabColor('s1', '#ef4444');
    store.reconnectSession(
      's1',
      { sessionId: 's2', title: 'New', host: 'h2', port: 2222, username: 'u2' },
      'profile-1',
    );

    const state = useTerminalStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.sessionId).toBe('s2');
    expect(state.sessions[0]?.replacesSessionId).toBe('s1');
    expect(state.sessions[0]?.title).toBe('Renamed');
    expect(state.sessions[0]?.profileId).toBe('profile-1');
    expect(state.sessions[0]?.pinned).toBe(true);
    expect(state.sessions[0]?.color).toBe('#ef4444');
    expect(state.sessions[0]?.reconnecting).toBe(true);
    expect(state.activeSessionId).toBe('s2');
  });

  it('keeps broker identity stable while reconnect advances its generation', () => {
    const store = useTerminalStore.getState();
    store.addSession({
      sessionId: 'transport-1',
      terminalSessionId: 'terminal-stable',
      terminalGeneration: 1,
      title: 'Local',
      host: 'local',
      port: 0,
      username: 'tester',
    });

    store.reconnectSession('transport-1', {
      sessionId: 'transport-2',
      terminalSessionId: 'terminal-stable',
      terminalGeneration: 2,
      title: 'Local',
      host: 'local',
      port: 0,
      username: 'tester',
    });

    expect(useTerminalStore.getState().sessions[0]).toMatchObject({
      sessionId: 'transport-2',
      terminalSessionId: 'terminal-stable',
      terminalGeneration: 2,
      replacesSessionId: 'transport-1',
    });
  });

  it('tracks reconnecting until the connection status settles', () => {
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 's1', title: 'A', host: 'h', port: 22, username: 'u' });

    store.setReconnecting('s1', true);
    expect(useTerminalStore.getState().sessions[0]?.reconnecting).toBe(true);

    store.setStatus('s1', { sessionId: 's1', status: 'connected' });
    expect(useTerminalStore.getState().sessions[0]?.reconnecting).toBe(false);
  });

  it('does not activate a background session when it reconnects', () => {
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 's1', title: 'A', host: 'h1', port: 22, username: 'u' });
    store.addSession({ sessionId: 's2', title: 'B', host: 'h2', port: 22, username: 'u' });
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');

    store.reconnectSession('s1', {
      sessionId: 's1-next',
      title: 'A',
      host: 'h1',
      port: 22,
      username: 'u',
    });

    expect(useTerminalStore.getState().activeSessionId).toBe('s2');
  });

  it('restores saved profile tabs as disconnected sessions preserving ids', () => {
    useTerminalStore.getState().addRestoredSessions([{
      sessionId: 'saved-1',
      title: 'Saved',
      host: 'example.com',
      port: 22,
      username: 'tester',
      profileId: 'profile-1',
    }]);

    expect(useTerminalStore.getState().sessions[0]).toMatchObject({
      sessionId: 'saved-1',
      title: 'Saved',
      status: 'disconnected',
      profileId: 'profile-1',
      closed: { retryable: true },
    });
  });

  it('never restores ephemeral broker identity from workspace-shaped input', () => {
    const restored = {
      sessionId: 'saved-1',
      title: 'Saved',
      host: 'example.com',
      port: 22,
      username: 'tester',
      profileId: 'profile-1',
      terminalSessionId: 'must-not-survive-restart',
      terminalGeneration: 99,
    } as TerminalWorkspaceSession & {
      terminalSessionId: string;
      terminalGeneration: number;
    };

    useTerminalStore.getState().addRestoredSessions([restored]);

    expect(useTerminalStore.getState().sessions[0]?.terminalSessionId).toBeUndefined();
    expect(useTerminalStore.getState().sessions[0]?.terminalGeneration).toBeUndefined();
  });

  it('stores restored layout alongside restored sessions', () => {
    const layout = {
      kind: 'split' as const,
      orientation: 'horizontal' as const,
      first: {
        kind: 'group' as const,
        id: 'first',
        sessionIds: ['saved-1'],
        activeSessionId: 'saved-1',
      },
      second: {
        kind: 'group' as const,
        id: 'second',
        sessionIds: [],
        activeSessionId: '',
      },
    };
    useTerminalStore.getState().addRestoredSessions([{
      sessionId: 'saved-1',
      title: 'Saved',
      host: 'example.com',
      port: 22,
      username: 'tester',
      profileId: 'profile-1',
    }], layout);

    expect(useTerminalStore.getState().restoredLayout).toEqual(layout);
  });

  it('inserts a duplicated session after the source tab', () => {
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 's1', title: 'A', host: 'h', port: 22, username: 'u' }, 'p1');
    store.addSession({ sessionId: 's2', title: 'B', host: 'h', port: 22, username: 'u' }, 'p1');
    store.addSession(
      { sessionId: 's3', title: 'C', host: 'h', port: 22, username: 'u' },
      'p1',
      { insertAfterId: 's1', pinned: true, color: '#ef4444' },
    );

    const ids = useTerminalStore.getState().sessions.map((s) => s.sessionId);
    expect(ids).toEqual(['s3', 's1', 's2']);
    expect(useTerminalStore.getState().sessions[0]).toMatchObject({
      sessionId: 's3',
      pinned: true,
      color: '#ef4444',
    });
  });

  it('marks a closed session as disconnected', () => {
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 's1', title: 'A', host: 'h', port: 22, username: 'u' });
    store.setClosed('s1', {
      sessionId: 's1',
      reasonKind: 'transport_disconnect',
      retryable: true,
    });
    expect(useTerminalStore.getState().sessions[0]?.status).toBe('disconnected');
  });
});
