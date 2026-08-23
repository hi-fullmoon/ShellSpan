import type { TerminalSession, TerminalWorkspaceSession } from '@/stores/terminalStore';
import type { TerminalLayoutNode } from '@/components/terminal/terminal-split';

export interface TerminalWorkspaceSnapshot {
  sessions: TerminalWorkspaceSession[];
  layout: TerminalLayoutNode | null;
}

export const TERMINAL_WORKSPACE_VERSION = 1;
const MAX_WORKSPACE_BYTES = 1024 * 1024;
const MAX_SESSIONS = 100;
const MAX_STRING_LENGTH = 4096;
const MAX_LAYOUT_DEPTH = 16;

export function serializeTerminalWorkspace(
  sessions: TerminalSession[],
  layout: TerminalLayoutNode | null,
): string {
  const snapshots: TerminalWorkspaceSession[] = sessions
    .filter((session) => Boolean(session.profileId))
    .slice(0, MAX_SESSIONS)
    .map(({
      sessionId,
      title,
      host,
      port,
      username,
      profileId,
      pinned,
      color,
      conversationId,
      conversationStartedAt,
    }) => ({
      sessionId,
      title,
      host,
      port,
      username,
      profileId,
      pinned,
      color,
      conversationId,
      conversationStartedAt,
    }));
  return JSON.stringify({ version: TERMINAL_WORKSPACE_VERSION, sessions: snapshots, layout });
}

export function parseTerminalWorkspace(raw: string | null): TerminalWorkspaceSnapshot {
  if (!raw) return { sessions: [], layout: null };
  if (new TextEncoder().encode(raw).byteLength > MAX_WORKSPACE_BYTES) {
    return { sessions: [], layout: null };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return { sessions: [], layout: null };
    const workspace = value as Record<string, unknown>;
    // Snapshots written before versioning are the only supported legacy shape.
    if (workspace.version !== undefined && workspace.version !== TERMINAL_WORKSPACE_VERSION) {
      return { sessions: [], layout: null };
    }
    const sessions = Array.isArray(workspace.sessions)
      ? workspace.sessions.slice(0, MAX_SESSIONS).filter(isTerminalWorkspaceSession)
      : [];
    const layout = isTerminalLayoutNode(workspace.layout, 0) ? workspace.layout : null;
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
    && session.sessionId.length <= MAX_STRING_LENGTH
    && typeof session.title === 'string'
    && session.title.length <= MAX_STRING_LENGTH
    && typeof session.host === 'string'
    && session.host.length <= MAX_STRING_LENGTH
    && typeof session.port === 'number'
    && Number.isInteger(session.port)
    && session.port >= 1
    && session.port <= 65535
    && typeof session.username === 'string'
    && session.username.length <= MAX_STRING_LENGTH
    && typeof session.profileId === 'string'
    && session.profileId.length > 0
    && session.profileId.length <= MAX_STRING_LENGTH
    && (session.pinned === undefined || typeof session.pinned === 'boolean')
    && (session.color === undefined || (typeof session.color === 'string' && session.color.length <= MAX_STRING_LENGTH))
    && (session.conversationId === undefined
      || (typeof session.conversationId === 'string' && session.conversationId.length <= MAX_STRING_LENGTH))
    && (session.conversationStartedAt === undefined
      || (typeof session.conversationStartedAt === 'string' && session.conversationStartedAt.length <= MAX_STRING_LENGTH));
}

function isTerminalLayoutNode(value: unknown, depth: number): value is TerminalLayoutNode {
  if (!value || typeof value !== 'object' || depth > MAX_LAYOUT_DEPTH) return false;
  const node = value as Record<string, unknown>;
  if (node.kind === 'group') {
    return typeof node.id === 'string'
      && node.id.length <= MAX_STRING_LENGTH
      && Array.isArray(node.sessionIds)
      && node.sessionIds.length <= MAX_SESSIONS
      && node.sessionIds.every((id) => typeof id === 'string' && id.length <= MAX_STRING_LENGTH)
      && typeof node.activeSessionId === 'string'
      && node.activeSessionId.length <= MAX_STRING_LENGTH;
  }
  if (node.kind === 'split') {
    return (
      node.orientation === 'horizontal' || node.orientation === 'vertical'
    ) && (node.split === undefined
      || (typeof node.split === 'number'
        && Number.isFinite(node.split)
        && node.split > 0
        && node.split < 1))
      && isTerminalLayoutNode(node.first, depth + 1)
      && isTerminalLayoutNode(node.second, depth + 1);
  }
  return false;
}
