interface SessionWithId {
  sessionId: string;
}

export function insertSessionAfterActive<T extends SessionWithId>(sessions: T[], nextSession: T, activeSessionId?: string) {
  if (!activeSessionId) {
    return [nextSession, ...sessions];
  }

  const activeIndex = sessions.findIndex((session) => session.sessionId === activeSessionId);
  if (activeIndex === -1) {
    return [nextSession, ...sessions];
  }

  const nextSessions = [...sessions];
  nextSessions.splice(activeIndex + 1, 0, nextSession);
  return nextSessions;
}
