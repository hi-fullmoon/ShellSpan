import { describe, expect, it } from 'vitest';
import {
  projectAgentConversationNodes,
  projectAskConversationNodes,
} from '@/lib/ai/conversation-projection';
import {
  agentSessionAllEventFamiliesFixture,
  agentSessionEventFixture,
  agentSessionWaitingApprovalEventFixture,
} from '@/test/fixtures/agent-session';
import {
  askFailedMessageFixture,
  askStreamingConversationFixture,
  askStreamingMessageFixture,
} from '@/test/fixtures/ask-streaming';
import type { AgentSessionEvent } from '@/types/agent-session';

const ALL_AGENT_EVENT_TYPES = [
  'session/created',
  'agent/created',
  'agent/status',
  'session/ended',
  'agent/inbox/spliced',
  'agent/inbox/item_updated',
  'agent/inbox/item_removed',
  'agent/inbox/reordered',
  'session/renamed',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/chunk',
  'assistant/message',
  'request/header',
  'request/context',
  'request/retry',
  'request/usage',
  'tool/call',
  'tool/approval',
  'tool/execution',
  'tool/result',
  'context/artifact',
  'compaction/start',
  'compaction/summary',
  'compaction/end',
  'subagent/descriptor',
  'subagent/message',
  'subagent/settled',
  'subagent/detached',
  'task/linked',
  'task/plan',
  'task/state',
  'task/evidence',
] satisfies readonly AgentSessionEvent['type'][];

describe('AI conversation node projection', () => {
  it('keeps the fixture exhaustive over the current Agent event union', () => {
    expect(new Set(agentSessionAllEventFamiliesFixture.map((event) => event.type)))
      .toEqual(new Set(ALL_AGENT_EVENT_TYPES));
  });

  it('folds every Agent business lifecycle into stable node kinds', () => {
    const nodes = projectAgentConversationNodes(agentSessionAllEventFamiliesFixture);
    const kinds = new Set(nodes.map((node) => node.kind));
    const categories = new Set(nodes.flatMap((node) => (
      node.kind === 'lifecycleMarker' ? [node.category] : []
    )));

    expect(kinds).toEqual(new Set([
      'userMessage',
      'assistantMessage',
      'tool',
      'artifact',
      'approvalMarker',
      'lifecycleMarker',
      'retry',
    ]));
    expect([...categories]).toEqual(expect.arrayContaining([
      'session',
      'agent',
      'inbox',
      'turn',
      'step',
      'request',
      'compaction',
      'recovery',
      'subagent',
      'task',
      'terminal',
    ]));
    expect(nodes.find((node) => (
      node.kind === 'lifecycleMarker'
      && node.key === 'marker:request:request-1'
    ))).toEqual(expect.objectContaining({
      eventTypes: expect.arrayContaining(['request/header', 'request/context', 'request/usage']),
    }));
    expect(nodes.find((node) => node.kind === 'tool')).toEqual(expect.objectContaining({
      key: 'tool:call-health',
      state: 'succeeded',
      lastSeq: expect.any(Number),
    }));
    expect(nodes.find((node) => node.kind === 'approvalMarker')).toEqual(expect.objectContaining({
      key: 'approval:approval-health',
      status: 'approved',
    }));
    expect(nodes.some((node) => (
      node.kind === 'lifecycleMarker'
      && node.category === 'compaction'
      && node.state === 'completed'
    ))).toBe(true);
  });

  it('updates one Assistant node across chunks and the committed message', () => {
    const firstChunk = projectAgentConversationNodes(agentSessionEventFixture.slice(0, 12));
    const secondChunk = projectAgentConversationNodes(agentSessionEventFixture.slice(0, 13));
    const committed = projectAgentConversationNodes(agentSessionEventFixture.slice(0, 14));
    const first = firstChunk.find((node) => node.kind === 'assistantMessage');
    const second = secondChunk.find((node) => node.kind === 'assistantMessage');
    const final = committed.find((node) => node.kind === 'assistantMessage');

    expect(first).toEqual(expect.objectContaining({ content: 'Checking ', state: 'streaming' }));
    expect(second).toEqual(expect.objectContaining({
      key: first?.key,
      content: 'Checking now.',
      state: 'streaming',
    }));
    expect(final).toEqual(expect.objectContaining({
      key: first?.key,
      content: 'Checking now.',
      state: 'completed',
    }));
    expect(committed.filter((node) => node.kind === 'assistantMessage')).toHaveLength(1);
  });

  it('keeps approval authority pending until a committed resolution event', () => {
    const nodes = projectAgentConversationNodes(agentSessionWaitingApprovalEventFixture);
    expect(nodes.find((node) => node.kind === 'approvalMarker')).toEqual(expect.objectContaining({
      status: 'requested',
    }));
    expect(nodes.find((node) => node.kind === 'tool')).toEqual(expect.objectContaining({
      state: 'approval',
    }));
  });

  it('is replay-idempotent and rejects unordered or gapped windows', () => {
    expect(projectAgentConversationNodes(agentSessionEventFixture))
      .toEqual(projectAgentConversationNodes(agentSessionEventFixture));
    expect(() => projectAgentConversationNodes([
      agentSessionEventFixture[0],
      { ...agentSessionEventFixture[1], seq: 2 },
    ])).toThrow('ordered and contiguous');
  });

  it('continues to project legacy v2 event history', () => {
    const legacy = agentSessionEventFixture.map((event) => ({ ...event, version: 2 as const }));
    expect(() => projectAgentConversationNodes(legacy)).not.toThrow();
    expect(projectAgentConversationNodes(legacy).some((node) => node.kind === 'userMessage')).toBe(true);
  });

  it('turns a future runtime event into an auditable unknown marker', () => {
    const unknownEvent = {
      ...agentSessionEventFixture[0],
      type: 'future/safe-extension',
      data: { status: 'completed' },
    } as unknown as AgentSessionEvent;
    expect(projectAgentConversationNodes([unknownEvent])).toEqual([
      expect.objectContaining({
        kind: 'lifecycleMarker',
        category: 'unknown',
        state: 'unknown',
        label: 'future/safe-extension',
        eventSeqs: [0],
      }),
    ]);
  });

  it.each([
    ['streaming', askStreamingMessageFixture, undefined],
    ['failed', askFailedMessageFixture, 'Provider disconnected.'],
  ] as const)('projects Ask %s state into the shared union', (_label, messages, error) => {
    const nodes = projectAskConversationNodes({
      conversation: askStreamingConversationFixture,
      messages,
      phase: error ? 'error' : 'streaming',
      error,
      errorRequestId: error ? messages[1].requestId : undefined,
    });
    expect(nodes[0]).toEqual(expect.objectContaining({
      kind: 'userMessage',
      key: 'user:ask-stream-user',
      delivery: error ? 'failed' : 'committed',
    }));
    expect(nodes[1]).toEqual(expect.objectContaining({
      kind: 'assistantMessage',
      key: 'assistant:ask-stream-request',
      content: messages[1].content,
      state: messages[1].status,
    }));
    expect(nodes.some((node) => node.kind === 'error')).toBe(Boolean(error));
  });

  it('keeps the Ask assistant key stable as cumulative stream content changes', () => {
    const partial = projectAskConversationNodes({
      conversation: askStreamingConversationFixture,
      messages: [
        askStreamingMessageFixture[0],
        { ...askStreamingMessageFixture[1], content: 'Inspecting ' },
      ],
      phase: 'streaming',
    });
    const complete = projectAskConversationNodes({
      conversation: askStreamingConversationFixture,
      messages: [
        askStreamingMessageFixture[0],
        { ...askStreamingMessageFixture[1], status: 'completed' },
      ],
      phase: 'idle',
    });
    expect(partial[1].key).toBe(complete[1].key);
    expect(complete[1]).toEqual(expect.objectContaining({
      content: 'Inspecting the deployment output.',
      state: 'completed',
    }));
  });
});
