import type { SessionState, SshStatusEvent } from "../types";

export type PendingSessionStatusEvents = Record<string, SshStatusEvent>;

export interface BufferedSessionSnapshot {
  status: SessionState["status"];
  note?: string;
}

export function applyStatusToSessions(
  sessions: SessionState[],
  payload: SshStatusEvent,
  pending: PendingSessionStatusEvents,
) {
  let matched = false;
  const nextSessions = sessions.map((session) => {
    if (session.sessionId !== payload.sessionId) {
      return session;
    }

    matched = true;
    return {
      ...session,
      status: payload.status,
      note: payload.message,
    };
  });

  if (matched) {
    delete pending[payload.sessionId];
  } else {
    pending[payload.sessionId] = payload;
  }

  return nextSessions;
}

export function consumeBufferedSessionStatus(
  sessionId: string,
  pending: PendingSessionStatusEvents,
): BufferedSessionSnapshot | undefined {
  const payload = pending[sessionId];
  if (!payload) {
    return undefined;
  }

  delete pending[sessionId];
  return {
    status: payload.status,
    note: payload.message,
  };
}
