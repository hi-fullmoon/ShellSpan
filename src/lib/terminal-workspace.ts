import type { TerminalSession, TerminalWorkspaceSession } from '@/stores/terminalStore';

export function serializeTerminalWorkspace(sessions: TerminalSession[]): string {
  const snapshots: TerminalWorkspaceSession[] = sessions
    .filter((session) => Boolean(session.profileId))
    .map(({ title, host, port, username, profileId, pinned, color }) => ({
      title,
      host,
      port,
      username,
      profileId,
      pinned,
      color,
    }));
  return JSON.stringify(snapshots);
}

export function parseTerminalWorkspace(raw: string | null): TerminalWorkspaceSession[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(isTerminalWorkspaceSession);
  } catch {
    return [];
  }
}

function isTerminalWorkspaceSession(value: unknown): value is TerminalWorkspaceSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Record<string, unknown>;
  return typeof session.title === 'string'
    && typeof session.host === 'string'
    && typeof session.port === 'number'
    && Number.isInteger(session.port)
    && session.port >= 1
    && session.port <= 65535
    && typeof session.username === 'string'
    && typeof session.profileId === 'string'
    && session.profileId.length > 0
    && (session.pinned === undefined || typeof session.pinned === 'boolean')
    && (session.color === undefined || typeof session.color === 'string');
}
