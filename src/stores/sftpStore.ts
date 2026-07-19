import { create } from 'zustand';
import { generateId } from '@/lib/utils';
import type {
  LocalDirectoryListing,
  LocalFileEntry,
  RemoteConnectionRequest,
  RemoteDirectoryListing,
  RemoteFileEntry,
  RemoteFileKind,
  SessionSummary,
} from '@/types';

export type SftpSide = 'local' | 'remote';
export type SftpPaneSource = 'empty' | 'local' | 'remote';

export interface SftpPaneState {
  pathInput: string;
  filterQuery: string;
  selectedPaths: string[];
  batchMode: boolean;
}

export interface SftpRemoteClipboard {
  sourcePath: string;
  sourceName: string;
  kind: RemoteFileKind;
}

export interface SftpConnection {
  id: string;
  sessionId?: string;
  profileId?: string;
  title: string;
  pinned?: boolean;
  connection: RemoteConnectionRequest;
  leftConnection?: RemoteConnectionRequest;
  leftTitle?: string;
  leftProfileId?: string;
  leftSource?: SftpPaneSource;
  rightSource?: SftpPaneSource;
  localPath: string;
  remotePath: string;
  localEntries: LocalFileEntry[];
  remoteEntries: RemoteFileEntry[];
  localLoading: boolean;
  remoteLoading: boolean;
  localError?: string;
  remoteError?: string;
  localPane: SftpPaneState;
  remotePane: SftpPaneState;
  remoteBookmarks: string[];
  remoteClipboard?: SftpRemoteClipboard;
  localOnly?: boolean;
  rightLocal?: boolean;
}

export interface SftpDirectoryListing {
  path: string;
  parentPath?: string;
  entries: (LocalFileEntry | RemoteFileEntry)[];
}

function createDefaultPaneState(): SftpPaneState {
  return {
    pathInput: '',
    filterQuery: '',
    selectedPaths: [],
    batchMode: false,
  };
}

function createDefaultConnection(
  id: string,
  summary: SessionSummary,
  connection: RemoteConnectionRequest,
  profileId?: string,
): SftpConnection {
  return {
    id,
    sessionId: summary.sessionId,
    profileId,
    title: summary.title,
    pinned: false,
    connection,
    localPath: '',
    remotePath: '',
    localEntries: [],
    remoteEntries: [],
    localLoading: false,
    remoteLoading: false,
    localPane: createDefaultPaneState(),
    remotePane: createDefaultPaneState(),
    remoteBookmarks: [],
    leftSource: 'local',
    rightSource: 'remote',
  };
}

interface SftpState {
  connections: SftpConnection[];
  activeConnectionId: string | null;
  addConnection: (
    summary: SessionSummary,
    connection: RemoteConnectionRequest,
    profileId?: string,
  ) => void;
  addLocalConnection: () => void;
  setPaneLocal: (id: string, side: SftpSide) => void;
  attachRemoteConnection: (
    id: string,
    side: SftpSide,
    summary: SessionSummary,
    connection: RemoteConnectionRequest,
    profileId?: string,
  ) => void;
  removeConnection: (id: string) => void;
  setActiveConnection: (id: string | null) => void;
  updateTitle: (id: string, title: string) => void;
  togglePin: (id: string) => void;
  reorderConnections: (activeId: string, insertIndex: number) => void;
  setPath: (id: string, side: SftpSide, path: string) => void;
  setEntries: (
    id: string,
    side: SftpSide,
    entries: LocalFileEntry[] | RemoteFileEntry[],
  ) => void;
  setLoading: (id: string, side: SftpSide, loading: boolean) => void;
  setError: (id: string, side: SftpSide, error?: string) => void;
  setPaneState: (
    id: string,
    side: SftpSide,
    patch:
      | Partial<SftpPaneState>
      | ((prev: SftpPaneState) => Partial<SftpPaneState>),
  ) => void;
  setRemoteClipboard: (
    id: string,
    clipboard?: SftpRemoteClipboard,
  ) => void;
  addRemoteBookmark: (id: string, path: string) => void;
  removeRemoteBookmark: (id: string, path: string) => void;
}

function updateConnection(
  state: SftpState,
  id: string,
  updater: (connection: SftpConnection) => SftpConnection,
): SftpConnection[] {
  return state.connections.map((connection) =>
    connection.id === id ? updater(connection) : connection,
  );
}

function getPaneKey(side: SftpSide): 'localPane' | 'remotePane' {
  return side === 'local' ? 'localPane' : 'remotePane';
}

function getPathKey(side: SftpSide): 'localPath' | 'remotePath' {
  return side === 'local' ? 'localPath' : 'remotePath';
}

function getEntriesKey(
  side: SftpSide,
): 'localEntries' | 'remoteEntries' {
  return side === 'local' ? 'localEntries' : 'remoteEntries';
}

function getLoadingKey(side: SftpSide): 'localLoading' | 'remoteLoading' {
  return side === 'local' ? 'localLoading' : 'remoteLoading';
}

function getErrorKey(side: SftpSide): 'localError' | 'remoteError' {
  return side === 'local' ? 'localError' : 'remoteError';
}

export function getSftpPaneSource(
  connection: SftpConnection,
  side: SftpSide,
): SftpPaneSource {
  return side === 'local'
    ? connection.leftSource ?? 'local'
    : connection.rightSource ?? (connection.localOnly ? (connection.rightLocal ? 'local' : 'empty') : 'remote');
}

export function getSftpPaneConnection(
  connection: SftpConnection,
  side: SftpSide,
): RemoteConnectionRequest {
  return side === 'local'
    ? connection.leftConnection ?? connection.connection
    : connection.connection;
}

export const useSftpStore = create<SftpState>()((set) => ({
  connections: [],
  activeConnectionId: null,

  addConnection: (summary, connection, profileId) =>
    set((state) => {
      const id = generateId();
      const conn = createDefaultConnection(id, summary, connection, profileId);
      return {
        connections: [...state.connections, conn],
        activeConnectionId: id,
      };
    }),

  addLocalConnection: () =>
    set((state) => {
      const id = generateId();
      const conn = createDefaultConnection(
        id,
        { sessionId: id, title: 'Local', host: '', port: 0, username: '' },
        { host: '', port: 22, username: '', authMethod: 'password' },
      );
      conn.localOnly = true;
      conn.rightLocal = false;
      conn.rightSource = 'empty';
      return { connections: [...state.connections, conn], activeConnectionId: id };
    }),

  setPaneLocal: (id, side) =>
    set((state) => ({
      connections: updateConnection(state, id, (current) => ({
        ...current,
        ...(side === 'local'
          ? {
              leftSource: 'local' as const,
              leftConnection: undefined,
              leftTitle: undefined,
              leftProfileId: undefined,
            }
          : { rightSource: 'local' as const, title: 'Local' }),
        localOnly:
          side === 'local'
            ? getSftpPaneSource(current, 'remote') !== 'remote'
            : getSftpPaneSource(current, 'local') !== 'remote',
        rightLocal: side === 'remote',
        [getPathKey(side)]: '',
        [getEntriesKey(side)]: [],
        [getErrorKey(side)]: undefined,
        [getPaneKey(side)]: createDefaultPaneState(),
      })),
      activeConnectionId: id,
    })),

  attachRemoteConnection: (id, side, summary, connection, profileId) =>
    set((state) => ({
      connections: updateConnection(state, id, (current) => ({
        ...current,
        ...(side === 'local'
          ? {
              leftSource: 'remote' as const,
              leftConnection: connection,
              leftTitle: summary.title,
              leftProfileId: profileId,
            }
          : {
              rightSource: 'remote' as const,
              sessionId: summary.sessionId,
              profileId,
              title: summary.title,
              connection,
            }),
        localOnly: false,
        rightLocal: side === 'remote' ? false : current.rightLocal,
        [getPathKey(side)]: '',
        [getEntriesKey(side)]: [],
        [getErrorKey(side)]: undefined,
        [getPaneKey(side)]: createDefaultPaneState(),
      })),
      activeConnectionId: id,
    })),

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

  updateTitle: (id, title) =>
    set((state) => ({
      connections: updateConnection(state, id, (connection) => ({
        ...connection,
        title,
      })),
    })),

  togglePin: (id) =>
    set((state) => {
      const pinnedConnections = state.connections.filter((c) => c.pinned);
      const unpinnedConnections = state.connections.filter((c) => !c.pinned);
      const target = state.connections.find((c) => c.id === id);
      if (!target) return state;

      const nextPinned = !target.pinned;
      const updated = { ...target, pinned: nextPinned };

      if (nextPinned) {
        return {
          connections: [
            ...pinnedConnections,
            updated,
            ...unpinnedConnections.filter((c) => c.id !== id),
          ],
        };
      }

      return {
        connections: [
          ...pinnedConnections.filter((c) => c.id !== id),
          updated,
          ...unpinnedConnections.filter((c) => c.id !== id),
        ],
      };
    }),

  reorderConnections: (activeId, insertIndex) =>
    set((state) => {
      const active = state.connections.find((c) => c.id === activeId);
      if (!active) return state;

      const pinnedCount = state.connections.filter((c) => c.pinned).length;
      const minIndex = active.pinned ? 0 : pinnedCount;
      const targetIndex = Math.max(minIndex, insertIndex);

      const others = state.connections.filter((c) => c.id !== activeId);
      others.splice(targetIndex, 0, active);

      return { connections: others };
    }),

  setPath: (id, side, path) =>
    set((state) => ({
      connections: updateConnection(state, id, (connection) => ({
        ...connection,
        [getPathKey(side)]: path,
      })),
    })),

  setEntries: (id, side, entries) =>
    set((state) => ({
      connections: updateConnection(state, id, (connection) => ({
        ...connection,
        [getEntriesKey(side)]: entries,
      })),
    })),

  setLoading: (id, side, loading) =>
    set((state) => ({
      connections: updateConnection(state, id, (connection) => ({
        ...connection,
        [getLoadingKey(side)]: loading,
      })),
    })),

  setError: (id, side, error) =>
    set((state) => ({
      connections: updateConnection(state, id, (connection) => ({
        ...connection,
        [getErrorKey(side)]: error,
      })),
    })),

  setPaneState: (id, side, patch) =>
    set((state) => ({
      connections: updateConnection(state, id, (connection) => {
        const paneKey = getPaneKey(side);
        const current = connection[paneKey];
        const nextPatch = typeof patch === 'function' ? patch(current) : patch;
        return {
          ...connection,
          [paneKey]: { ...current, ...nextPatch },
        };
      }),
    })),

  setRemoteClipboard: (id, clipboard) =>
    set((state) => ({
      connections: updateConnection(state, id, (connection) => ({
        ...connection,
        remoteClipboard: clipboard,
      })),
    })),

  addRemoteBookmark: (id, path) =>
    set((state) => ({
      connections: updateConnection(state, id, (connection) => ({
        ...connection,
        remoteBookmarks: connection.remoteBookmarks.includes(path)
          ? connection.remoteBookmarks
          : [...connection.remoteBookmarks, path],
      })),
    })),

  removeRemoteBookmark: (id, path) =>
    set((state) => ({
      connections: updateConnection(state, id, (connection) => ({
        ...connection,
        remoteBookmarks: connection.remoteBookmarks.filter((p) => p !== path),
      })),
    })),
}));
