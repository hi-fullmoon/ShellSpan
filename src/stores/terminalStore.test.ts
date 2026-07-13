import { describe, expect, it, beforeEach } from 'vitest';
import { useTerminalStore } from './terminalStore';

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

    store.reconnectSession(
      's1',
      { sessionId: 's2', title: 'New', host: 'h2', port: 2222, username: 'u2' },
      'profile-1',
    );

    const state = useTerminalStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]?.sessionId).toBe('s2');
    expect(state.sessions[0]?.title).toBe('Renamed');
    expect(state.sessions[0]?.profileId).toBe('profile-1');
    expect(state.sessions[0]?.pinned).toBe(true);
    expect(state.sessions[0]?.color).toBe('#ef4444');
    expect(state.activeSessionId).toBe('s2');
  });
});