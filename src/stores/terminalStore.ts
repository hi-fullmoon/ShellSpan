import { create } from 'zustand';
import type { TerminalLayoutNode } from '@/components/terminal/terminal-split';
import type { ClosedEvent, SessionStatus, SessionSummary, StatusEvent } from '@/types';
import { generateId } from '@/lib/utils';

export interface TerminalSession {
  sessionId: string;
  title: string;
  host: string;
  port: number;
  username: string;
  status: SessionStatus;
  statusMessage?: string;
  closed?: ClosedEvent;
  profileId?: string;
  pinned?: boolean;
  color?: string;
  reconnecting?: boolean;
  pendingConnection?: boolean;
  /** Ephemeral predecessor used to keep split layout stable while a connection id changes. */
  replacesSessionId?: string;
}

export interface PendingTerminalConnection {
  title: string;
  host: string;
  port: number;
  username: string;
  profileId?: string;
  insertAfterId?: string;
  pinned?: boolean;
  color?: string;
}

export type TerminalWorkspaceSession = Pick<
  TerminalSession,
  'sessionId' | 'title' | 'host' | 'port' | 'username' | 'profileId' | 'pinned' | 'color'
>;

const sortSessions = (sessions: TerminalSession[]): TerminalSession[] => {
  const pinned = sessions.filter((session) => session.pinned);
  const unpinned = sessions.filter((session) => !session.pinned);
  return [...pinned, ...unpinned];
};

interface TerminalState {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  restoredLayout: TerminalLayoutNode | null;
  beginConnectionAttempt: (
    pending: PendingTerminalConnection,
    attemptId?: string,
  ) => string;
  resolveConnectionAttempt: (
    attemptId: string,
    summary: SessionSummary,
    profileId?: string,
  ) => void;
  endConnectionAttempt: (attemptId: string) => void;
  addSession: (
    summary: SessionSummary,
    profileId?: string,
    options?: { insertAfterId?: string; pinned?: boolean; color?: string },
  ) => void;
  addRestoredSessions: (
    sessions: TerminalWorkspaceSession[],
    layout?: TerminalLayoutNode | null,
  ) => void;
  removeSession: (sessionId: string) => void;
  reconnectSession: (
    oldSessionId: string,
    summary: SessionSummary,
    profileId?: string,
  ) => void;
  setReconnecting: (sessionId: string, reconnecting: boolean) => void;
  reorderSessions: (activeId: string, insertIndex: number) => void;
  setActiveSession: (sessionId: string | null) => void;
  setRestoredLayout: (layout: TerminalLayoutNode | null) => void;
  clearRestoredLayout: () => void;
  setStatus: (sessionId: string, event: StatusEvent) => void;
  setClosed: (sessionId: string, event: ClosedEvent) => void;
  updateTitle: (sessionId: string, title: string) => void;
  togglePin: (sessionId: string) => void;
  setTabColor: (sessionId: string, color?: string) => void;
}

export const useTerminalStore = create<TerminalState>()((set) => ({
  sessions: [],
  activeSessionId: null,
  restoredLayout: null,
  beginConnectionAttempt: (pending, attemptId = `pending-${generateId()}`) => {
    set((state) => {
      const existingIndex = state.sessions.findIndex(
        (session) => session.sessionId === attemptId && session.pendingConnection,
      );
      if (existingIndex >= 0) {
        const sessions = [...state.sessions];
        const existing = sessions[existingIndex];
        sessions[existingIndex] = {
          ...existing,
          title: pending.title,
          host: pending.host,
          port: pending.port,
          username: pending.username,
          profileId: pending.profileId ?? existing.profileId,
          pinned: pending.pinned ?? existing.pinned,
          color: pending.color ?? existing.color,
        };
        return { sessions, activeSessionId: attemptId };
      }

      const pendingSession: TerminalSession = {
        sessionId: attemptId,
        title: pending.title,
        host: pending.host,
        port: pending.port,
        username: pending.username,
        status: 'connecting',
        profileId: pending.profileId,
        pinned: pending.pinned,
        color: pending.color,
        pendingConnection: true,
      };
      const sourceIndex = pending.insertAfterId
        ? state.sessions.findIndex((session) => session.sessionId === pending.insertAfterId)
        : -1;
      const sessions = [...state.sessions];
      if (sourceIndex >= 0) {
        sessions.splice(sourceIndex + 1, 0, pendingSession);
      } else {
        sessions.push(pendingSession);
      }
      return {
        sessions: sortSessions(sessions),
        activeSessionId: attemptId,
      };
    });
    return attemptId;
  },
  resolveConnectionAttempt: (attemptId, summary, profileId) =>
    set((state) => {
      const pendingIndex = state.sessions.findIndex(
        (session) => session.sessionId === attemptId && session.pendingConnection,
      );
      if (pendingIndex < 0) return state;

      const pending = state.sessions[pendingIndex];
      const sessions = [...state.sessions];
      sessions[pendingIndex] = {
        sessionId: summary.sessionId,
        title: summary.title,
        host: summary.host,
        port: summary.port,
        username: summary.username,
        status: 'connecting',
        profileId: profileId ?? pending.profileId,
        pinned: pending.pinned,
        color: pending.color,
        replacesSessionId: attemptId,
      };
      return {
        sessions,
        activeSessionId: state.activeSessionId === attemptId
          ? summary.sessionId
          : state.activeSessionId,
      };
    }),
  endConnectionAttempt: (attemptId) =>
    set((state) => {
      const pendingIndex = state.sessions.findIndex(
        (session) => session.sessionId === attemptId && session.pendingConnection,
      );
      if (pendingIndex < 0) return state;
      const sessions = state.sessions.filter((session) => session.sessionId !== attemptId);
      return {
        sessions,
        activeSessionId: state.activeSessionId === attemptId
          ? sessions[sessions.length - 1]?.sessionId ?? null
          : state.activeSessionId,
      };
    }),
  addSession: (summary, profileId, options) =>
    set((state) => {
      const exists = state.sessions.some(
        (session) => session.sessionId === summary.sessionId,
      );
      if (exists) return state;

      const sourceIndex = options?.insertAfterId
        ? state.sessions.findIndex(
            (session) => session.sessionId === options.insertAfterId,
          )
        : -1;
      const newSession: TerminalSession = {
        sessionId: summary.sessionId,
        title: summary.title,
        host: summary.host,
        port: summary.port,
        username: summary.username,
        status: 'connecting',
        profileId,
        pinned: options?.pinned,
        color: options?.color,
      };

      let sessions: TerminalSession[];
      if (sourceIndex >= 0) {
        sessions = [...state.sessions];
        sessions.splice(sourceIndex + 1, 0, newSession);
        sessions = sortSessions(sessions);
      } else {
        sessions = sortSessions([...state.sessions, newSession]);
      }

      return {
        sessions,
        activeSessionId: summary.sessionId,
      };
    }),
  addRestoredSessions: (restored, layout) =>
    set((state) => {
      if (state.sessions.length > 0 || restored.length === 0) return state;
      const sessions = restored.map((session) => ({
        ...session,
        status: 'disconnected' as const,
        closed: {
          sessionId: session.sessionId,
          reasonKind: 'transport_disconnect' as const,
          retryable: true,
        },
      }));
      return {
        sessions,
        activeSessionId: sessions[0]?.sessionId ?? null,
        restoredLayout: layout ?? null,
      };
    }),
  setRestoredLayout: (layout) => set({ restoredLayout: layout }),
  clearRestoredLayout: () => set({ restoredLayout: null }),
  removeSession: (sessionId) =>
    set((state) => {
      if (!state.sessions.some((session) => session.sessionId === sessionId)) {
        return state;
      }
      const sessions = state.sessions.filter(
        (session) => session.sessionId !== sessionId,
      );
      const activeSessionId =
        state.activeSessionId === sessionId
          ? sessions[sessions.length - 1]?.sessionId ?? null
          : state.activeSessionId;
      return { sessions, activeSessionId };
    }),
  reconnectSession: (oldSessionId, summary, profileId) =>
    set((state) => {
      const oldIndex = state.sessions.findIndex(
        (session) => session.sessionId === oldSessionId,
      );
      // The old session may have been closed while the reconnect was in flight;
      // never resurrect it.
      if (oldIndex === -1) return state;
      const old = state.sessions[oldIndex];
      const newSession: TerminalSession = {
        sessionId: summary.sessionId,
        title: old.title ?? summary.title,
        host: summary.host,
        port: summary.port,
        username: summary.username,
        status: 'connecting',
        profileId,
        pinned: old.pinned,
        color: old.color,
        reconnecting: true,
        replacesSessionId: oldSessionId,
      };
      const sessions = state.sessions.filter(
        (session) => session.sessionId !== oldSessionId,
      );
      sessions.splice(oldIndex, 0, newSession);
      return {
        sessions: sortSessions(sessions),
        activeSessionId: state.activeSessionId === oldSessionId
          ? summary.sessionId
          : state.activeSessionId,
      };
    }),
  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),
  setReconnecting: (sessionId, reconnecting) =>
    set((state) => {
      let changed = false;
      const sessions = state.sessions.map((session) => {
        if (session.sessionId !== sessionId) return session;
        changed = true;
        return { ...session, reconnecting };
      });
      return changed ? { sessions } : state;
    }),
  reorderSessions: (activeId, insertIndex) =>
    set((state) => {
      const fromIndex = state.sessions.findIndex(
        (session) => session.sessionId === activeId,
      );
      if (fromIndex === -1) return state;
      const sessions = [...state.sessions];
      const [moved] = sessions.splice(fromIndex, 1);
      const clampedIndex = Math.max(0, Math.min(insertIndex, sessions.length));
      sessions.splice(clampedIndex, 0, moved);
      return { sessions: sortSessions(sessions) };
    }),
  setStatus: (sessionId, event) =>
    set((state) => {
      let changed = false;
      const sessions = state.sessions.map((session) => {
        if (session.sessionId !== sessionId) return session;
        changed = true;
        return {
          ...session,
          status: event.status,
          statusMessage: event.message,
          reconnecting:
            event.status === 'connecting' ? session.reconnecting : false,
        };
      });
      return changed ? { sessions } : state;
    }),
  setClosed: (sessionId, event) =>
    set((state) => {
      let changed = false;
      const sessions: TerminalSession[] = state.sessions.map((session) => {
        if (session.sessionId !== sessionId) return session;
        changed = true;
        return {
          ...session,
          closed: event,
          status: event.reasonKind === 'error' ? 'error' : 'disconnected',
        };
      });
      return changed ? { sessions } : state;
    }),
  updateTitle: (sessionId, title) =>
    set((state) => {
      let changed = false;
      const sessions = state.sessions.map((session) => {
        if (session.sessionId !== sessionId) return session;
        changed = true;
        return { ...session, title };
      });
      return changed ? { sessions } : state;
    }),
  togglePin: (sessionId) =>
    set((state) => {
      let changed = false;
      const sessions = state.sessions.map((session) => {
        if (session.sessionId !== sessionId) return session;
        changed = true;
        return { ...session, pinned: !session.pinned };
      });
      return changed ? { sessions: sortSessions(sessions) } : state;
    }),
  setTabColor: (sessionId, color) =>
    set((state) => {
      let changed = false;
      const sessions = state.sessions.map((session) => {
        if (session.sessionId !== sessionId) return session;
        changed = true;
        return { ...session, color };
      });
      return changed ? { sessions } : state;
    }),
}));
