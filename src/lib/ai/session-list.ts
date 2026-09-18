import type { AiSessionAdapter, AiSessionSummary, ListSessionsInput } from './session-adapter';

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
