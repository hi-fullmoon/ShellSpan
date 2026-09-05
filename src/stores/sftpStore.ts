import { create } from 'zustand';
import { generateId } from '@/lib/utils';
import type {
  ConnectionProfile,
  LocalFileEntry,
  RemoteConnectionRequest,
  RemoteFileEntry,
  RemoteFileKind,
  SessionSummary,
} from '@/types';
import {
  buildRemoteConnectionRequest,
  invokeListSftpBookmarks,
  invokeAddSftpBookmark,
  invokeRemoveSftpBookmark,
  invokeDisconnectSftp,
} from '@/lib/ipc/tauri';
import type { SavedSftpTab } from '@/lib/sftp/sftp-workspace';
import { safeInvoke } from '@/lib/utils';
import { createLogger } from '@/lib/logger';
import {
  activatePathOperationOwner,
  cancelQueuedPathOperationsForOwner,
  hasActivePathOperation,
  useTransferStore,
} from './transferStore';
import type { FileEntry } from '@/components/sftp/utils';
import { usePortForwardStore } from './portForwardStore';

const logger = createLogger('sftpStore');

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
  sourceSide: SftpSide;
  sourceConnection: RemoteConnectionRequest;
  sourceConnectionKey: string;
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
  remoteBookmarks: Record<SftpSide, string[]>;
  remoteClipboard?: SftpRemoteClipboard;
  localOnly?: boolean;
  rightLocal?: boolean;
  splitRatio: number;
  restorePending?: Partial<Record<SftpSide, boolean>>;
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
    remoteBookmarks: { local: [], remote: [] },
    leftSource: 'local',
    rightSource: 'remote',
    splitRatio: 0.5,
  };
}

interface SftpState {
  connections: SftpConnection[];
  activeConnectionId: string | null;
  // Local files live in the one shared filesystem, so unlike remoteClipboard
  // this is app-global: copy in one local pane, paste in any other.
  localClipboard: FileEntry[];
  setLocalClipboard: (entries: FileEntry[]) => void;
  addConnection: (
    summary: SessionSummary,
    connection: RemoteConnectionRequest,
    profileId?: string,
    options?: { insertAfterId?: string; pinned?: boolean },
  ) => void;
  addLocalConnection: () => void;
  addRestoredConnections: (
    tabs: SavedSftpTab[],
    activeConnectionId: string | null,
    profiles: ConnectionProfile[],
  ) => void;
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
  updateConnectionRequest: (
    id: string,
    side: SftpSide,
    request: RemoteConnectionRequest,
  ) => void;
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
  hydrateSftpBookmarks: (host: string, port: number, username: string, connectionId: string, side: SftpSide) => Promise<void>;
  addRemoteBookmark: (id: string, side: SftpSide, path: string) => void;
  removeRemoteBookmark: (id: string, side: SftpSide, path: string) => void;
  setSplitRatio: (id: string, ratio: number) => void;
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

export function getSftpPaneConnectionKey(
  connection: SftpConnection,
  side: SftpSide,
): string {
  const request = getSftpPaneConnection(connection, side);
  const jump = request.jumpHost;
  return JSON.stringify([
    request.host,
    request.port,
    request.username,
    jump?.host ?? '',
    jump?.port ?? 0,
    jump?.username ?? '',
  ]);
}

// True while any tracked transfer still holds paths on this connection. The
// connection's own paths are fed back into hasActivePathOperation so its
// overlap check reduces to "any active transfer on this connection".
function hasActiveTransfer(connectionKey: string): boolean {
  const operations = useTransferStore.getState().operations;
  const paths = operations.flatMap((operation) => {
    const scopes: Array<{ connectionId?: string; paths: string[] }> =
      operation.pathScopes ?? [
        { connectionId: operation.connectionId, paths: operation.paths ?? [] },
      ];
    return scopes
      .filter((scope) => scope.connectionId === connectionKey)
      .flatMap((scope) => scope.paths);
  });
  return hasActivePathOperation(connectionKey, paths, operations);
}

// Disconnect the pooled backend SFTP session of every distinct remote pane of
// a closing tab. Fire-and-forget so closing never blocks on network teardown;
// a pane with an in-flight transfer is left to the backend idle TTL instead.
function disconnectRemotePanes(connection: SftpConnection): void {
  const seen = new Set<string>();
  for (const side of ['remote', 'local'] as SftpSide[]) {
    if (getSftpPaneSource(connection, side) !== 'remote') continue;
    const connectionKey = getSftpPaneConnectionKey(connection, side);
    if (seen.has(connectionKey)) continue;
    seen.add(connectionKey);
    if (hasActiveTransfer(connectionKey)) continue;
    invokeDisconnectSftp(getSftpPaneConnection(connection, side)).catch(
      (error) => {
        logger.error('failed to disconnect SFTP connection', error);
      },
    );
  }
}

export const useSftpStore = create<SftpState>()((set) => ({
  connections: [],
  activeConnectionId: null,
  localClipboard: [],

  setLocalClipboard: (entries) => set({ localClipboard: entries }),

  addConnection: (summary, connection, profileId, options) =>
    set((state) => {
      const id = generateId();
      activatePathOperationOwner(id);
      const conn = createDefaultConnection(id, summary, connection, profileId);
      conn.pinned = options?.pinned ?? false;

      const sourceIndex = options?.insertAfterId
        ? state.connections.findIndex((c) => c.id === options.insertAfterId)
        : -1;

      let connections: SftpConnection[];
      if (sourceIndex >= 0) {
        connections = [...state.connections];
        connections.splice(sourceIndex + 1, 0, conn);
      } else {
        connections = [...state.connections, conn];
      }

      return {
        connections,
        activeConnectionId: id,
      };
    }),

  addLocalConnection: () =>
    set((state) => {
      const id = generateId();
      activatePathOperationOwner(id);
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

  addRestoredConnections: (tabs, savedActiveConnectionId, profiles) =>
    set((state) => {
      const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
      const restored = tabs.map((tab) => {
        const leftProfile = tab.leftProfileId
          ? profileById.get(tab.leftProfileId)
          : undefined;
        const rightProfile = tab.rightProfileId
          ? profileById.get(tab.rightProfileId)
          : undefined;
        const leftSource = tab.leftSource === 'remote' && !leftProfile
          ? 'local'
          : tab.leftSource;
        const rightSource = tab.rightSource === 'remote' && !rightProfile
          ? 'empty'
          : tab.rightSource;
        const primaryProfile = rightProfile ?? leftProfile;
        const request = primaryProfile
          ? buildRemoteConnectionRequest(primaryProfile)
          : { host: '', port: 22, username: '', authMethod: 'password' as const };
        const connection = createDefaultConnection(
          tab.id,
          {
            sessionId: tab.id,
            title: tab.title,
            host: primaryProfile?.host ?? '',
            port: primaryProfile?.port ?? 22,
            username: primaryProfile?.username ?? '',
          },
          request,
          rightProfile?.id,
        );
        connection.sessionId = undefined;
        connection.title = tab.title;
        connection.pinned = tab.pinned;
        connection.leftSource = leftSource;
        connection.rightSource = rightSource;
        connection.leftProfileId = leftProfile?.id;
        connection.leftConnection = leftProfile
          ? buildRemoteConnectionRequest(leftProfile)
          : undefined;
        connection.leftTitle = leftProfile?.name;
        connection.profileId = rightProfile?.id;
        connection.connection = rightProfile
          ? buildRemoteConnectionRequest(rightProfile)
          : request;
        connection.localPath = leftSource === 'local' && tab.leftSource === 'remote'
          ? ''
          : tab.localPath;
        connection.remotePath = tab.remotePath;
        connection.remoteBookmarks = {
          local: [...tab.remoteBookmarks.local],
          remote: [...tab.remoteBookmarks.remote],
        };
        connection.splitRatio = tab.splitRatio;
        connection.localOnly = leftSource !== 'remote' && rightSource !== 'remote';
        connection.rightLocal = rightSource === 'local';
        connection.restorePending = {
          local: leftSource === 'remote',
          remote: rightSource === 'remote',
        };
        activatePathOperationOwner(connection.id);
        return connection;
      });
      if (restored.length === 0) return state;
      const activeConnectionId = restored.some(
        (connection) => connection.id === savedActiveConnectionId,
      )
        ? savedActiveConnectionId
        : restored[0]?.id ?? null;
      return { connections: restored, activeConnectionId };
    }),

  setPaneLocal: (id, side) => {
    void usePortForwardStore.getState().stopOwnersByPrefix(`sftp:${id}:${side}:`);
    set((state) => ({
      connections: updateConnection(state, id, (current) => ({
        ...current,
        ...(side === 'local'
          ? {
              leftSource: 'local' as const,
              leftConnection: undefined,
              leftTitle: undefined,
              leftProfileId: undefined,
              restorePending: { ...current.restorePending, local: false },
              // The tab title follows the remaining remote pane; without one
              // the tab is local-only and must not keep a stale host name.
              ...(getSftpPaneSource(current, 'remote') === 'remote'
                ? {}
                : { title: 'Local' }),
            }
          : {
              rightSource: 'local' as const,
              // Keep the left pane's remote title when it is the only remote
              // pane left, so the tab does not lose the host name.
              title: current.leftTitle ?? 'Local',
              restorePending: { ...current.restorePending, remote: false },
            }),
        localOnly:
          side === 'local'
            ? getSftpPaneSource(current, 'remote') !== 'remote'
            : getSftpPaneSource(current, 'local') !== 'remote',
        rightLocal: side === 'remote',
        [getPathKey(side)]: '',
        [getEntriesKey(side)]: [],
        [getErrorKey(side)]: undefined,
        [getPaneKey(side)]: createDefaultPaneState(),
        remoteBookmarks: { ...current.remoteBookmarks, [side]: [] },
        remoteClipboard:
          current.remoteClipboard?.sourceSide === side
            ? undefined
            : current.remoteClipboard,
      })),
      activeConnectionId: id,
    }));
  },

  attachRemoteConnection: (id, side, summary, connection, profileId) =>
    set((state) => ({
      connections: updateConnection(state, id, (current) => {
        const wasRestored = current.restorePending?.[side] === true;
        return {
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
          [getPathKey(side)]: wasRestored ? current[getPathKey(side)] : '',
          [getEntriesKey(side)]: [],
          [getErrorKey(side)]: undefined,
          [getPaneKey(side)]: createDefaultPaneState(),
          restorePending: { ...current.restorePending, [side]: false },
          remoteBookmarks: wasRestored
            ? current.remoteBookmarks
            : { ...current.remoteBookmarks, [side]: [] },
          remoteClipboard:
            current.remoteClipboard?.sourceSide === side
              ? undefined
              : current.remoteClipboard,
        };
      }),
      activeConnectionId: id,
    })),

  removeConnection: (id) => {
    void usePortForwardStore.getState().stopOwnersByPrefix(`sftp:${id}:`);
    set((state) => {
      const closing = state.connections.find((conn) => conn.id === id);
      const connections = state.connections.filter((conn) => conn.id !== id);
      const activeConnectionId =
        state.activeConnectionId === id
          ? connections[connections.length - 1]?.id ?? null
          : state.activeConnectionId;
      if (closing) {
        cancelQueuedPathOperationsForOwner(id);
        disconnectRemotePanes(closing);
      }
      return { connections, activeConnectionId };
    });
  },

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
      // Pinned tabs must stay inside the pinned group at the front.
      const maxIndex = active.pinned
        ? pinnedCount - 1
        : state.connections.length - 1;
      const targetIndex = Math.min(Math.max(minIndex, insertIndex), maxIndex);

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

  updateConnectionRequest: (id, side, request) =>
    set((state) => ({
      connections: updateConnection(state, id, (connection) => ({
        ...connection,
        ...(side === 'local'
          ? { leftConnection: request }
          : { connection: request }),
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

  hydrateSftpBookmarks: async (host, port, username, connectionId, side) => {
    try {
      const rows = await invokeListSftpBookmarks(host, port, username);
      const paths = rows
        .filter((r) => r.side === side)
        .map((r) => r.path);
      if (paths.length === 0) return;
      set((state) => ({
        connections: updateConnection(state, connectionId, (connection) => ({
          ...connection,
          remoteBookmarks: {
            ...connection.remoteBookmarks,
            [side]: [...new Set([...connection.remoteBookmarks[side], ...paths])],
          },
        })),
      }));
      logger.info(`loaded ${paths.length} SFTP bookmarks for ${username}@${host}`);
    } catch (error) {
      logger.error('failed to hydrate SFTP bookmarks', error);
    }
  },

  addRemoteBookmark: (id, side, path) => {
    const connection = useSftpStore.getState().connections.find((c) => c.id === id);
    set((state) => ({
      connections: updateConnection(state, id, (conn) => ({
        ...conn,
        remoteBookmarks: {
          ...conn.remoteBookmarks,
          [side]: conn.remoteBookmarks[side].includes(path)
            ? conn.remoteBookmarks[side]
            : [...conn.remoteBookmarks[side], path],
        },
      })),
    }));
    // Write-through to SQLite (fire-and-forget)
    if (connection) {
      const paneConnection = getSftpPaneConnection(connection, side);
      const now = Date.now();
      safeInvoke(invokeAddSftpBookmark, {
        id: `${paneConnection.host}:${paneConnection.port}:${paneConnection.username}:${side}:${path}`,
        host: paneConnection.host,
        port: paneConnection.port,
        username: paneConnection.username,
        path,
        side,
        createdAt: now,
      });
    }
  },

  removeRemoteBookmark: (id, side, path) => {
    const connection = useSftpStore.getState().connections.find((c) => c.id === id);
    set((state) => ({
      connections: updateConnection(state, id, (conn) => ({
        ...conn,
        remoteBookmarks: {
          ...conn.remoteBookmarks,
          [side]: conn.remoteBookmarks[side].filter((p) => p !== path),
        },
      })),
    }));
    // Write-through to SQLite (fire-and-forget)
    if (connection) {
      const paneConnection = getSftpPaneConnection(connection, side);
      const bookmarkId = `${paneConnection.host}:${paneConnection.port}:${paneConnection.username}:${side}:${path}`;
      safeInvoke(invokeRemoveSftpBookmark, bookmarkId);
    }
  },

  setSplitRatio: (id, ratio) =>
    set((state) => ({
      connections: updateConnection(state, id, (connection) => ({
        ...connection,
        splitRatio: ratio,
      })),
    })),
}));
