import {
  invokeArchiveAgentRuntimeSession,
  invokeCancelAgentRuntime,
  invokeDeleteAgentRuntimeSession,
  invokeListAgentRuntimeSessions,
} from '@/lib/ipc/tauri';
import type { AgentSessionListItem } from '@/types/agent-session';

/** Delete continuations before their source, regardless of timestamps. */
export function orderSessionRecordsForDeletion(records: readonly AgentSessionListItem[]): AgentSessionListItem[] {
  const byId = new Map(records.map((record) => [record.header.sessionId, record]));
  const children = new Map<string, number>();
  for (const record of records) {
    const parent = record.header.continuedFromSessionId;
    if (parent && byId.has(parent)) children.set(parent, (children.get(parent) ?? 0) + 1);
  }
  const ordered = records.filter((record) => !children.has(record.header.sessionId));
  for (let index = 0; index < ordered.length; index++) {
    const parent = ordered[index].header.continuedFromSessionId;
    if (!parent || !byId.has(parent)) continue;
    const remaining = children.get(parent)! - 1;
    children.set(parent, remaining);
    if (remaining === 0) ordered.push(byId.get(parent)!);
  }
  if (ordered.length !== records.length) throw new Error('Cyclic session continuation references');
  return ordered;
}

export async function deleteAgentSessionRecord(record: AgentSessionListItem): Promise<void> {
  const sessionId = record.header.sessionId;
  if (!record.archived) {
    if (!record.ended) await invokeCancelAgentRuntime({ sessionId });
    await invokeArchiveAgentRuntimeSession({ sessionId });
  }
  await invokeDeleteAgentRuntimeSession({ sessionId });
}

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
