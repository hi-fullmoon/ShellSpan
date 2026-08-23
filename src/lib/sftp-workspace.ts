import type { SftpConnection, SftpPaneSource } from '@/stores/sftpStore';

export const SFTP_WORKSPACE_VERSION = 1;

export interface SavedSftpTab {
  id: string;
  title: string;
  pinned: boolean;
  leftSource: SftpPaneSource;
  rightSource: SftpPaneSource;
  leftProfileId?: string;
  rightProfileId?: string;
  localPath: string;
  remotePath: string;
  splitRatio: number;
  remoteBookmarks: { local: string[]; remote: string[] };
}

export interface SftpWorkspaceSnapshot {
  version: typeof SFTP_WORKSPACE_VERSION;
  activeConnectionId: string | null;
  tabs: SavedSftpTab[];
}

export function serializeSftpWorkspace(
  connections: SftpConnection[],
  activeConnectionId: string | null,
): string {
  const tabs: SavedSftpTab[] = connections.map((connection) => ({
    id: connection.id,
    title: connection.title,
    pinned: connection.pinned ?? false,
    leftSource: connection.leftSource ?? 'local',
    rightSource: connection.rightSource
      ?? (connection.localOnly ? (connection.rightLocal ? 'local' : 'empty') : 'remote'),
    leftProfileId: connection.leftProfileId,
    rightProfileId: connection.profileId,
    localPath: connection.localPath,
    remotePath: connection.remotePath,
    splitRatio: connection.splitRatio,
    remoteBookmarks: {
      local: [...connection.remoteBookmarks.local],
      remote: [...connection.remoteBookmarks.remote],
    },
  }));
  return JSON.stringify({
    version: SFTP_WORKSPACE_VERSION,
    activeConnectionId: tabs.some((tab) => tab.id === activeConnectionId)
      ? activeConnectionId
      : tabs[0]?.id ?? null,
    tabs,
  } satisfies SftpWorkspaceSnapshot);
}

export function parseSftpWorkspace(raw: string | null): SftpWorkspaceSnapshot {
  const empty: SftpWorkspaceSnapshot = {
    version: SFTP_WORKSPACE_VERSION,
    activeConnectionId: null,
    tabs: [],
  };
  if (!raw) return empty;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return empty;
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== SFTP_WORKSPACE_VERSION || !Array.isArray(candidate.tabs)) {
      return empty;
    }
    const tabs = candidate.tabs.filter(isSavedSftpTab);
    const activeConnectionId = typeof candidate.activeConnectionId === 'string'
      && tabs.some((tab) => tab.id === candidate.activeConnectionId)
      ? candidate.activeConnectionId
      : tabs[0]?.id ?? null;
    return { version: SFTP_WORKSPACE_VERSION, activeConnectionId, tabs };
  } catch {
    return empty;
  }
}

function isSafeString(value: unknown, maximum = 32_768): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function isSource(value: unknown): value is SftpPaneSource {
  return value === 'empty' || value === 'local' || value === 'remote';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 1_000
    && value.every((item) => isSafeString(item));
}

function isSavedSftpTab(value: unknown): value is SavedSftpTab {
  if (!value || typeof value !== 'object') return false;
  const tab = value as Record<string, unknown>;
  const bookmarks = tab.remoteBookmarks as Record<string, unknown> | undefined;
  return isSafeString(tab.id, 256)
    && tab.id.length > 0
    && isSafeString(tab.title, 1_024)
    && typeof tab.pinned === 'boolean'
    && isSource(tab.leftSource)
    && isSource(tab.rightSource)
    && (tab.leftProfileId === undefined || isSafeString(tab.leftProfileId, 256))
    && (tab.rightProfileId === undefined || isSafeString(tab.rightProfileId, 256))
    && isSafeString(tab.localPath)
    && isSafeString(tab.remotePath)
    && typeof tab.splitRatio === 'number'
    && Number.isFinite(tab.splitRatio)
    && tab.splitRatio >= 0.1
    && tab.splitRatio <= 0.9
    && !!bookmarks
    && isStringArray(bookmarks.local)
    && isStringArray(bookmarks.remote);
}
