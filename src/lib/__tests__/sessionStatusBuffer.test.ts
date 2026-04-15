import { describe, expect, it } from 'vitest';
import type { SessionState, SshStatusEvent } from '../../types';
import {
  applyStatusToSessions,
  consumeBufferedSessionStatus,
} from '../sessionStatusBuffer';

function makeSession(
  sessionId: string,
  status: SessionState['status'] = 'connecting',
): SessionState {
  return {
    sessionId,
    title: 'demo',
    host: 'example.com',
    port: 22,
    username: 'root',
    profile: {
      id: 'profile-1',
      name: 'demo',
      host: 'example.com',
      port: 22,
      username: 'root',
      authMethod: 'password',
    },
    status,
    createdAt: Date.now(),
  };
}

describe('sessionStatusBuffer', () => {
  it('buffers status events when the session has not been inserted yet', () => {
    const pending: Record<string, SshStatusEvent> = {};
    const payload: SshStatusEvent = {
      sessionId: 's1',
      status: 'connected',
      message: 'shell ready',
    };

    const sessions = applyStatusToSessions([], payload, pending);

    expect(sessions).toEqual([]);
    expect(pending.s1).toEqual(payload);
  });

  it('consumes buffered status for late session insertion', () => {
    const pending: Record<string, SshStatusEvent> = {
      s1: {
        sessionId: 's1',
        status: 'connected',
        message: 'shell ready',
      },
    };

    const consumed = consumeBufferedSessionStatus('s1', pending);

    expect(consumed).toEqual({
      status: 'connected',
      note: 'shell ready',
    });
    expect(pending.s1).toBeUndefined();
  });

  it('updates existing session directly and clears stale pending cache', () => {
    const pending: Record<string, SshStatusEvent> = {
      s1: {
        sessionId: 's1',
        status: 'connecting',
        message: 'dialing',
      },
    };
    const payload: SshStatusEvent = {
      sessionId: 's1',
      status: 'error',
      message: 'auth failed',
    };

    const sessions = applyStatusToSessions([makeSession('s1')], payload, pending);

    expect(sessions[0]?.status).toBe('error');
    expect(sessions[0]?.note).toBe('auth failed');
    expect(pending.s1).toBeUndefined();
  });
});
