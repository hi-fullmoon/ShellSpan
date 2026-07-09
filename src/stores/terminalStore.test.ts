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

  it('reorderSessions moves active before over', () => {
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 's1', title: 'A', host: 'h', port: 22, username: 'u' });
    store.addSession({ sessionId: 's2', title: 'B', host: 'h', port: 22, username: 'u' });
    store.addSession({ sessionId: 's3', title: 'C', host: 'h', port: 22, username: 'u' });
    store.reorderSessions('s3', 's1');
    const ids = useTerminalStore.getState().sessions.map((s) => s.sessionId);
    expect(ids).toEqual(['s3', 's1', 's2']);
  });

  it('addSession persists profileId when provided', () => {
    useTerminalStore.getState().addSession(
      { sessionId: 's1', title: 'A', host: 'h', port: 22, username: 'u' },
      'profile-1',
    );
    expect(useTerminalStore.getState().sessions[0]?.profileId).toBe('profile-1');
  });

  it('addSession without profileId leaves it undefined', () => {
    useTerminalStore.getState().addSession(
      { sessionId: 's1', title: 'A', host: 'h', port: 22, username: 'u' },
    );
    expect(useTerminalStore.getState().sessions[0]?.profileId).toBeUndefined();
  });
});
