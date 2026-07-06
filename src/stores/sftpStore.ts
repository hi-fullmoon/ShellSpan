import { create } from 'zustand';
import type {
  LocalDirectoryListing,
  LocalFileEntry,
  RemoteConnectionRequest,
  RemoteDirectoryListing,
  RemoteFileEntry,
  SessionSummary,
} from '@/types';

export type SftpSide = 'local' | 'remote';

export interface SftpConnection {
  id: string;
  sessionId?: string;
  title: string;
  connection: RemoteConnectionRequest;
  localPath: string;
  remotePath: string;
  localEntries: LocalFileEntry[];
  remoteEntries: RemoteFileEntry[];
  localLoading: boolean;
  remoteLoading: boolean;
  localError?: string;
  remoteError?: string;
}

interface SftpState {
  connections: SftpConnection[];
  activeConnectionId: string | null;
  addConnection: (summary: SessionSummary, connection: RemoteConnectionRequest) => void;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;
  setPath: (id: string, side: SftpSide, path: string) => void;
  setEntries: (
    id: string,
    side: SftpSide,
    entries: LocalFileEntry[] | RemoteFileEntry[],
  ) => void;
  setLoading: (id: string, side: SftpSide, loading: boolean) => void;
  setError: (id: string, side: SftpSide, error?: string) => void;
}

export const useSftpStore = create<SftpState>()((set) => ({
  connections: [],
  activeConnectionId: null,
  addConnection: (summary, connection) =>
    set((state) => {
      const id = summary.sessionId;
      const exists = state.connections.some((conn) => conn.id === id);
      if (exists) return state;
      const conn: SftpConnection = {
        id,
        sessionId: id,
        title: summary.title,
        connection,
        localPath: '',
        remotePath: '',
        localEntries: [],
        remoteEntries: [],
        localLoading: false,
        remoteLoading: false,
      };
      return {
        connections: [...state.connections, conn],
        activeConnectionId: id,
      };
    }),
  removeConnection: (id) =>
    set((state) => {
      const connections = state.connections.filter((conn) => conn.id !== id);
      const activeConnectionId =
        state.activeConnectionId === id
          ? connections[connections.length - 1]?.id ?? null
          : state.activeConnectionId;
      return { connections, activeConnectionId };
    }),
  setActiveConnection: (id) => set({ activeConnectionId: id }),
  setPath: (id, side, path) =>
    set((state) => ({
      connections: state.connections.map((conn) =>
        conn.id === id
          ? { ...conn, [side === 'local' ? 'localPath' : 'remotePath']: path }
          : conn,
      ),
    })),
  setEntries: (id, side, entries) =>
    set((state) => ({
      connections: state.connections.map((conn) =>
        conn.id === id
          ? {
              ...conn,
              [side === 'local' ? 'localEntries' : 'remoteEntries']: entries,
            }
          : conn,
      ),
    })),
  setLoading: (id, side, loading) =>
    set((state) => ({
      connections: state.connections.map((conn) =>
        conn.id === id
          ? {
              ...conn,
              [side === 'local' ? 'localLoading' : 'remoteLoading']: loading,
            }
          : conn,
      ),
    })),
  setError: (id, side, error) =>
    set((state) => ({
      connections: state.connections.map((conn) =>
        conn.id === id
          ? {
              ...conn,
              [side === 'local' ? 'localError' : 'remoteError']: error,
            }
          : conn,
      ),
    })),
}));
