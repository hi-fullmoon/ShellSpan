import type { AiSessionAdapter, AiSessionSummary, ListSessionsInput } from './session-adapter';

/** Terminal and Focus have separate conversation histories over shared targets. */
export function belongsToAiWorkspace(
  summary: Pick<AiSessionSummary, 'id' | 'parentSessionId'>,
  scope: 'workbench' | 'terminal',
  focusMode: boolean,
  sessions: readonly Pick<AiSessionSummary, 'id' | 'parentSessionId'>[] = [],
): boolean {
  if (scope === 'workbench') return true;
  let current = summary;
  const visited = new Set<string>();
  while (current.parentSessionId) {
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    const parentId = current.parentSessionId;
    const parent = sessions.find(session => session.id === parentId);
    if (!parent) {
      // Known root identities still identify ownership when the parent is archived.
      if (parentId.startsWith('focus-agent-')) return focusMode;
      if (parentId.startsWith('agent-')) return !focusMode;
      return false;
    }
    current = parent;
  }
  return current.id.startsWith('focus-agent-') === focusMode;
}

/** A subagent remains top-level when its durable parent is no longer listed. */
export function isTopLevelAiSession(
  summary: AiSessionSummary,
  sessions: readonly AiSessionSummary[],
): boolean {
  if (summary.subagent === undefined || summary.parentSessionId === undefined) return true;
  return !sessions.some((candidate) => candidate.id === summary.parentSessionId);
}

/** Runtime pages are ascending and may be empty after the adapter's scope filter. */
export async function listAllAiSessions(
  adapter: Pick<AiSessionAdapter, 'list'>,
  input: ListSessionsInput,
  isCurrent: () => boolean,
): Promise<readonly AiSessionSummary[] | null> {
  const sessions = new Map<string, AiSessionSummary>();
  const cursors = new Set<string>();
  let cursor = input.cursor;
  while (isCurrent()) {
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new Error('Session list returned a repeated cursor');
      cursors.add(cursor);
    }
    const page = await adapter.list({ ...input, ...(cursor === undefined ? {} : { cursor }) });
    if (!isCurrent()) return null;
    for (const summary of page.sessions) sessions.set(`${summary.kind}:${summary.id}`, summary);
    if (page.nextCursor === undefined) {
      return [...sessions.values()].sort((left, right) => (
        right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)
      ));
    }
    cursor = page.nextCursor;
  }
  return null;
}
