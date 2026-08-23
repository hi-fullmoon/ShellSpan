import { describe, expect, it, beforeEach } from 'vitest';
import { useTerminalStore } from '../terminalStore';

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
    expect(state.sessions[0]?.conversationId).toBeTruthy();
    expect(state.sessions[0]?.conversationStartedAt).toBeTruthy();
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
    const conversationId = useTerminalStore.getState().sessions[0]?.conversationId;

    store.reconnectSession(
      's1',
      { sessionId: 's2', title: 'New', host: 'h2', port: 2222, username: 'u2' },
      'profile-1',
    );

    const state = useTerminalStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.sessionId).toBe('s2');
    expect(state.sessions[0]?.conversationId).toBe(conversationId);
    expect(state.sessions[0]?.title).toBe('Renamed');
    expect(state.sessions[0]?.profileId).toBe('profile-1');
    expect(state.sessions[0]?.pinned).toBe(true);
    expect(state.sessions[0]?.color).toBe('#ef4444');
    expect(state.sessions[0]?.reconnecting).toBe(true);
    expect(state.activeSessionId).toBe('s2');
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
