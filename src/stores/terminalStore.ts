import { create } from 'zustand';
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
}

interface TerminalState {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  addSession: (summary: SessionSummary, profileId?: string) => void;
  removeSession: (sessionId: string) => void;
  reorderSessions: (activeId: string, overId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  appendData: (sessionId: string, chunk: string) => void;
  setStatus: (sessionId: string, event: StatusEvent) => void;
  setClosed: (sessionId: string, event: ClosedEvent) => void;
  updateTitle: (sessionId: string, title: string) => void;
}

export const useTerminalStore = create<TerminalState>()((set) => ({
  sessions: [],
  activeSessionId: null,
  addSession: (summary, profileId) =>
    set((state) => {
      const exists = state.sessions.some(
        (session) => session.sessionId === summary.sessionId,
      );
      if (exists) return state;
      return {
        sessions: [
          ...state.sessions,
          {
            sessionId: summary.sessionId,
            title: summary.title,
            host: summary.host,
            port: summary.port,
            username: summary.username,
            status: 'connecting',
            profileId,
          },
        ],
        activeSessionId: summary.sessionId,
      };
    }),
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
  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),
  reorderSessions: (activeId, overId) =>
    set((state) => {
      if (activeId === overId) return state;
      const fromIndex = state.sessions.findIndex(
        (session) => session.sessionId === activeId,
      );
      const toIndex = state.sessions.findIndex(
        (session) => session.sessionId === overId,
      );
      if (fromIndex === -1 || toIndex === -1) return state;
      const sessions = [...state.sessions];
      const [moved] = sessions.splice(fromIndex, 1);
      sessions.splice(toIndex, 0, moved);
      return { sessions };
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
            }
          : session,
      ),
    })),
  setClosed: (sessionId, event) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.sessionId === sessionId
          ? { ...session, closed: event }
          : session,
      ),
    })),
  updateTitle: (sessionId, title) =>
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.sessionId === sessionId ? { ...session, title } : session,
      ),
    })),
}));
