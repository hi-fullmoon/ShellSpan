import { create } from "zustand";
import type { RemoteDirectoryListing, UploadProgressState } from "../types";

export interface FileManagerSessionState {
  error?: string;
  listing?: RemoteDirectoryListing;
  pathInput: string;
  selectedPath?: string;
  uploadProgress?: UploadProgressState;
}

type SessionStatePatch =
  | Partial<FileManagerSessionState>
  | ((current: FileManagerSessionState) => Partial<FileManagerSessionState>);

interface FileManagerStoreState {
  sessions: Record<string, FileManagerSessionState>;
  removeSessionState: (sessionId: string) => void;
  replaceSessionStateKey: (fromSessionId: string, toSessionId: string) => void;
  updateSessionState: (sessionId: string, patch: SessionStatePatch) => void;
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
}));
