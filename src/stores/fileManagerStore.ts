import { create } from "zustand";
import type { OperationLogEntry } from "../components/FileManager/types";
import type { RemoteDirectoryListing } from "../types";

export interface FileManagerSessionState {
  error?: string;
  listing?: RemoteDirectoryListing;
  pathInput: string;
  selectedPath?: string;
  selectedPaths?: string[];
  viewMode?: "list" | "compact";
  operationLogs?: OperationLogEntry[];
}

type SessionStatePatch =
  | Partial<FileManagerSessionState>
  | ((current: FileManagerSessionState) => Partial<FileManagerSessionState>);

interface FileManagerStoreState {
  sessions: Record<string, FileManagerSessionState>;
  removeSessionState: (sessionId: string) => void;
  replaceSessionStateKey: (fromSessionId: string, toSessionId: string) => void;
  updateSessionState: (sessionId: string, patch: SessionStatePatch) => void;
  appendOperationLog: (sessionId: string, entry: OperationLogEntry) => void;
  updateOperationLog: (
    sessionId: string,
    id: string,
    patch: Partial<OperationLogEntry>,
  ) => void;
  clearOperationLogs: (sessionId: string) => void;
}

function createEmptySessionState(): FileManagerSessionState {
  return {
    pathInput: "",
  };
}

export const useFileManagerStore = create<FileManagerStoreState>((set) => ({
  sessions: {},
  updateSessionState: (sessionId, patch) =>
    set((state) => {
      const current = state.sessions[sessionId] ?? createEmptySessionState();
      const nextPatch = typeof patch === "function" ? patch(current) : patch;

      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...current,
            ...nextPatch,
          },
        },
      };
    }),
  removeSessionState: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.sessions)) {
        return state;
      }

      const nextSessions = { ...state.sessions };
      delete nextSessions[sessionId];
      return { sessions: nextSessions };
    }),
  replaceSessionStateKey: (fromSessionId, toSessionId) =>
    set((state) => {
      const current = state.sessions[fromSessionId];
      if (!current || fromSessionId === toSessionId) {
        return state;
      }

      const nextSessions = { ...state.sessions };
      delete nextSessions[fromSessionId];
      nextSessions[toSessionId] = current;

      return { sessions: nextSessions };
    }),
  appendOperationLog: (sessionId, entry) =>
    set((state) => {
      const current = state.sessions[sessionId] ?? createEmptySessionState();
      const logs = [entry, ...(current.operationLogs ?? [])].slice(0, 50);
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...current, operationLogs: logs },
        },
      };
    }),
  updateOperationLog: (sessionId, id, patch) =>
    set((state) => {
      const current = state.sessions[sessionId];
      if (!current) return state;
      const logs = (current.operationLogs ?? []).map((log) =>
        log.id === id ? { ...log, ...patch } : log,
      );
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...current, operationLogs: logs },
        },
      };
    }),
  clearOperationLogs: (sessionId) =>
    set((state) => {
      const current = state.sessions[sessionId];
      if (!current) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...current, operationLogs: [] },
        },
      };
    }),
}));
