import { expect, it } from 'vitest';
import { createAgentChatProjector, projectAgentChatNodes } from '../conversation-projection';
import type { AiCompactionNode, AiConversationNode } from '../conversation-node';
import type { AgentSessionEvent } from '@/types/agent-session';
import capture from '@/test/fixtures/compaction-progress.json';
import { projectAgentActivity } from '../agent-session-projection';

const traces = capture as unknown as Record<'completed' | 'failed' | 'cancelled', readonly AgentSessionEvent[]>;
function compactions(nodes: readonly AiConversationNode[]): AiCompactionNode[] {
  return nodes.flatMap(node => node.kind === 'compaction' ? [node]
    : node.kind === 'turnProcess' ? compactions(node.children) : []);
}

it.each(['completed', 'failed', 'cancelled'] as const)('replays real %s progress with its recorded duration', state => {
  const events = traces[state];
  const start = events.findIndex(event => event.type === 'compaction/start');
  const end = events.find(event => event.type === 'compaction/end');
  if (end?.type !== 'compaction/end') throw new Error('Recorded compaction end required');
  const project = createAgentChatProjector();
  for (let length = 1; length <= events.length; length += 1) {
    const prefix = events.slice(0, length);
    expect(project(prefix)).toEqual(projectAgentChatNodes(prefix));
  }
  const active = compactions(projectAgentChatNodes(events.slice(0, start + 1)));
  // Preparation can run before the driver's first running status is committed.
  expect(projectAgentActivity(events.slice(0, start)).status).toBe('idle');
  expect(projectAgentActivity(events.slice(0, start + 1)).status).toBe('running');
  expect(projectAgentActivity(events).status).toBe('idle');
  expect(active).toHaveLength(1);
  expect(active[0]).toMatchObject({ state: 'running', durationMs: null, startedAtUnixMs: events[start].timeUnixMs });
  const settled = compactions(project(events));
  expect(settled).toHaveLength(1);
  expect(settled[0]).toMatchObject({ state, durationMs: end.data.durationMs, compactionId: end.data.compactionId });
  // A paged history window can contain an end without its start. The backend
  // duration remains available, while an unknown start must stay unknown.
  expect(compactions(projectAgentChatNodes([end]))[0]).toMatchObject({ state, durationMs: end.data.durationMs, startedAtUnixMs: null });
});

it('does not infer fast durations from legacy atomic compaction events', () => {
  const events: AgentSessionEvent[] = traces.completed.map(event => {
    if (event.type === 'compaction/start') return { ...event, data: { reason: event.data.reason } };
    if (event.type === 'compaction/end') return { ...event, data: {
      status: event.data.status, surfaceGeneration: event.data.surfaceGeneration,
      replacedThroughSeq: event.data.replacedThroughSeq,
    } };
    return event;
  });
  expect(compactions(projectAgentChatNodes(events))).toEqual([]);
});
