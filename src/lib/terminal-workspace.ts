import type { TerminalSession, TerminalWorkspaceSession } from '@/stores/terminalStore';
import type { TerminalLayoutNode } from '@/components/terminal/terminal-split';

export interface TerminalWorkspaceSnapshot {
  sessions: TerminalWorkspaceSession[];
  layout: TerminalLayoutNode | null;
}

export function serializeTerminalWorkspace(
  sessions: TerminalSession[],
  layout: TerminalLayoutNode | null,
): string {
  const snapshots: TerminalWorkspaceSession[] = sessions
    .filter((session) => Boolean(session.profileId))
    .map(({ sessionId, title, host, port, username, profileId, pinned, color }) => ({
      sessionId,
      title,
      host,
      port,
      username,
      profileId,
      pinned,
      color,
    }));
  return JSON.stringify({ sessions: snapshots, layout });
}

export function parseTerminalWorkspace(raw: string | null): TerminalWorkspaceSnapshot {
  if (!raw) return { sessions: [], layout: null };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return { sessions: [], layout: null };
    const workspace = value as Record<string, unknown>;
    const sessions = Array.isArray(workspace.sessions)
      ? workspace.sessions.filter(isTerminalWorkspaceSession)
      : [];
    const layout = isTerminalLayoutNode(workspace.layout) ? workspace.layout : null;
    return { sessions, layout };
  } catch {
    return { sessions: [], layout: null };
  }
}

function isTerminalWorkspaceSession(value: unknown): value is TerminalWorkspaceSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Record<string, unknown>;
  return typeof session.sessionId === 'string'
    && session.sessionId.length > 0
    && typeof session.title === 'string'
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

function isTerminalLayoutNode(value: unknown): value is TerminalLayoutNode {
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  if (node.kind === 'group') {
    return typeof node.id === 'string'
      && Array.isArray(node.sessionIds)
      && node.sessionIds.every((id) => typeof id === 'string')
      && typeof node.activeSessionId === 'string';
  }
  if (node.kind === 'split') {
    return (
      node.orientation === 'horizontal' || node.orientation === 'vertical'
    ) && isTerminalLayoutNode(node.first)
      && isTerminalLayoutNode(node.second);
  }
  return false;
}
