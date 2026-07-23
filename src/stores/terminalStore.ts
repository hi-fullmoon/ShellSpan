import { create } from 'zustand';
import type { TerminalLayoutNode } from '@/components/terminal/terminal-split';
import type { ClosedEvent, SessionStatus, SessionSummary, StatusEvent } from '@/types';

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
  appendData: (sessionId: string, chunk: string) => void;
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
      const old = oldIndex >= 0 ? state.sessions[oldIndex] : undefined;
      const newSession: TerminalSession = {
        sessionId: summary.sessionId,
        title: old?.title ?? summary.title,
        host: summary.host,
        port: summary.port,
        username: summary.username,
        status: 'connecting',
        profileId,
        pinned: old?.pinned,
        color: old?.color,
        reconnecting: true,
      };
      const sessions = state.sessions.filter(
        (session) => session.sessionId !== oldSessionId,
      );
      sessions.splice(oldIndex >= 0 ? oldIndex : sessions.length, 0, newSession);
      return {
        sessions: sortSessions(sessions),
        activeSessionId: summary.sessionId,
      };
    }),
  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),
  setReconnecting: (sessionId, reconnecting) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.sessionId === sessionId ? { ...session, reconnecting } : session,
      ),
    })),
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
  appendData: () => {
    // Terminal component handles data directly via xterm.
  },
  setStatus: (sessionId, event) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.sessionId === sessionId
          ? {
              ...session,
              status: event.status,
              statusMessage: event.message,
              reconnecting:
                event.status === 'connecting' ? session.reconnecting : false,
            }
          : session,
      ),
    })),
  setClosed: (sessionId, event) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.sessionId === sessionId
          ? {
              ...session,
              closed: event,
              status: event.reasonKind === 'error' ? 'error' : 'disconnected',
            }
          : session,
      ),
    })),
  updateTitle: (sessionId, title) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.sessionId === sessionId ? { ...session, title } : session,
      ),
    })),
  togglePin: (sessionId) =>
    set((state) => ({
      sessions: sortSessions(
        state.sessions.map((session) =>
          session.sessionId === sessionId
            ? { ...session, pinned: !session.pinned }
            : session,
        ),
      ),
    })),
  setTabColor: (sessionId, color) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.sessionId === sessionId ? { ...session, color } : session,
      ),
    })),
}));
