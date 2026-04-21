import { describe, expect, it } from 'vitest';
import { insertSessionAfterActive } from '../sessionOrder';

interface TestSession {
  sessionId: string;
}

function makeSession(sessionId: string): TestSession {
  return { sessionId };
}

describe('insertSessionAfterActive', () => {
  it('inserts a new session after the active session', () => {
    const current = [makeSession('session-1'), makeSession('session-2'), makeSession('session-3')];
    const nextSession = makeSession('session-4');

    const ordered = insertSessionAfterActive(current, nextSession, 'session-2');

    expect(ordered.map((session) => session.sessionId)).toEqual(['session-1', 'session-2', 'session-4', 'session-3']);
  });

  it('prepends when there is no active session', () => {
    const current = [makeSession('session-1'), makeSession('session-2')];
    const nextSession = makeSession('session-3');

    const ordered = insertSessionAfterActive(current, nextSession);

    expect(ordered.map((session) => session.sessionId)).toEqual(['session-3', 'session-1', 'session-2']);
  });
});
