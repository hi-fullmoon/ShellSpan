import { invokeListAgentRuntimeSessions } from '@/lib/ipc/tauri';
import type { AgentSessionListItem } from '@/types/agent-session';

/** The runtime paginates globally; settings must not inherit a terminal scope. */
export async function listAllAgentSessionRecords(): Promise<AgentSessionListItem[]> {
  const records: AgentSessionListItem[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await invokeListAgentRuntimeSessions({ limit: 256, ...(cursor ? { cursor } : {}) });
    records.push(...page.sessions);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Repeated Agent Session cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return records.sort((left, right) => (
    right.header.createdAtUnixMs - left.header.createdAtUnixMs
  ));
}
