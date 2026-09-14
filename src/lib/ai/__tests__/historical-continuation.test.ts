import { describe, expect, it } from 'vitest';
import { canContinueHistoricalConversation, withHistoricalConversation } from '../historical-continuation';
import type { AgentSessionSnapshot } from '@/types/agent-session';
import type { TerminalSession } from '@/stores/terminalStore';
import type { AiSessionView } from '../session-adapter';

const snapshot: AgentSessionSnapshot = {
  header: {
    sessionId: 'agent-old', taskId: 'task-old', goal: 'Finish the explanation',
    target: { kind: 'remote', targetId: 'terminal-old', sessionId: 'old',
      host: 'example.test', port: 22, username: 'tester' },
    executionSurface: 'direct', createdAtUnixMs: 1,
  },
  status: 'completed', ended: true, archived: false, eventCount: 1,
  surface: { generation: 0, messages: [] },
  inbox: { nextTurn: [], nextStep: [] }, task: { evidence: [] },
  recovery: { kind: 'idle', status: 'none', summary: '', lastCommittedSeq: 1 },
};
const current: TerminalSession = {
  sessionId: 'new', title: 'Remote', host: 'example.test', port: 22,
  username: 'tester', status: 'connected',
};

describe('historical conversation continuation', () => {
  it('requires a connected terminal with the same login and a different target session', () => {
    expect(canContinueHistoricalConversation(snapshot, current)).toBe(true);
    expect(canContinueHistoricalConversation(snapshot, { ...current, status: 'disconnected' })).toBe(false);
    expect(canContinueHistoricalConversation(snapshot, { ...current, username: 'other' })).toBe(false);
    expect(canContinueHistoricalConversation(snapshot, { ...current, sessionId: 'old' })).toBe(false);
    expect(canContinueHistoricalConversation({ ...snapshot, header: { ...snapshot.header,
      subagent: {} as NonNullable<typeof snapshot.header.subagent> } }, current)).toBe(false);
  });

  it('keeps the complete source node list before new nodes without key collisions', () => {
    const sourceNode = { kind: 'userMessage' as const, key: 'user:1', sourceKind: 'agent' as const,
      sessionId: 'agent-old', turnId: 'turn-old', stepId: null, firstSeq: 2, lastSeq: 2,
      timestamp: '2026-09-14T00:00:00Z', messageId: '1', content: 'All source records', delivery: 'committed' as const };
    const newNode = { ...sourceNode, sessionId: 'agent-new', content: 'New reply' };
    const source: AiSessionView = { summary: { id: 'agent-old', kind: 'agent', title: 'Old',
      updatedAt: '', status: 'completed', scopeKey: 'login', archived: false },
      snapshot: { kind: 'agent', value: snapshot }, nodes: [sourceNode], activityNodes: [], inbox: [],
      pendingApproval: null, status: 'completed', error: null, throughSeq: 2, canLoadOlder: false };
    const continued: AiSessionView = { ...source, summary: { ...source.summary, id: 'agent-new' },
      nodes: [newNode] };
    const combined = withHistoricalConversation(continued, [source]);
    expect(combined.nodes.map((node) => node.key)).toEqual(['history:agent-old:user:1', 'user:1']);
    expect(combined.nodes.map((node) => node.kind === 'userMessage' ? node.content : null))
      .toEqual(['All source records', 'New reply']);
    expect(source.nodes[0].key).toBe('user:1');
  });
});
