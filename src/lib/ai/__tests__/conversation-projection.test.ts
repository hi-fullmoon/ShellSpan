import { describe, expect, it } from 'vitest';

import {
  aggregateDurableSessionStats,
  projectAgentChatNodes,
} from '@/lib/ai/conversation-projection';
import type {
  AiConversationNode,
  AiTurnProcessChildNode,
  AiTurnProcessNode,
} from '@/lib/ai/conversation-node';
import {
  agentSessionAllEventFamiliesFixture,
  agentSessionEventFixture,
  agentSessionWaitingApprovalEventFixture,
} from '@/test/fixtures/agent-session';
import { agentSessionBaselineScenarios } from '@/test/fixtures/agent-session-baseline';
import v4Fixture from '@/test/fixtures/agent-session-v5.json';
import type { AgentSessionEvent } from '@/types/agent-session';

const ALL_AGENT_EVENT_TYPES = [
  'session/created',
  'agent/created',
  'agent/status',
  'session/ended',
  'agent/inbox/spliced',
  'agent/inbox/item_updated',
  'agent/inbox/item_removed',
  'agent/inbox/item_steered',
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
  'request/start',
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

function turnProcess(
  nodes: readonly AiConversationNode[],
  turnId = 'turn-01',
): AiTurnProcessNode {
  const node = nodes.find((candidate) => (
    candidate.kind === 'turnProcess' && candidate.turnId === turnId
  ));
  expect(node?.kind).toBe('turnProcess');
  return node as AiTurnProcessNode;
}

function processChild<Kind extends AiTurnProcessChildNode['kind']>(
  nodes: readonly AiConversationNode[],
  kind: Kind,
  turnId = 'turn-01',
): Extract<AiTurnProcessChildNode, { readonly kind: Kind }> | undefined {
  return turnProcess(nodes, turnId).children.find(
    (candidate): candidate is Extract<AiTurnProcessChildNode, { readonly kind: Kind }> => (
      candidate.kind === kind
    ),
  );
}

function projectionKeys(nodes: readonly AiConversationNode[]): readonly string[] {
  return nodes.flatMap((node) => (
    node.kind === 'turnProcess'
      ? [node.key, ...node.children.map((child) => `${node.key}/${child.key}`)]
      : [node.key]
  ));
}

function requestHeader(
  seq: number,
  changes: Partial<Extract<AgentSessionEvent, { type: 'request/header' }>['data']> = {},
): Extract<AgentSessionEvent, { type: 'request/header' }> {
  const header = agentSessionBaselineScenarios.hello.events.find(
    (event) => event.type === 'request/header',
  );
  if (!header) throw new Error('Missing baseline request header');
  return {
    ...header,
    seq,
    stepId: `step-${seq}`,
    timeUnixMs: header.timeUnixMs + seq * 100,
    data: {
      ...header.data,
      requestId: `request-${seq}`,
      reason: seq === 0 ? 'initial' : 'toolContinuation',
      series: { seriesId: `series-${seq}`, requestIndex: 0, startsSeries: true },
      ...changes,
    },
  };
}

describe('AI Phase 3 chat projection', () => {
  it('keeps the fixture exhaustive over the current Event v5 union', () => {
    expect(new Set(agentSessionAllEventFamiliesFixture.map((event) => event.type)))
      .toEqual(new Set(ALL_AGENT_EVENT_TYPES));
  });

  it('projects hello as prompt, user, process, answer, and durable tail', () => {
    const nodes = projectAgentChatNodes(agentSessionBaselineScenarios.hello.events);
    expect(nodes.map((node) => node.kind)).toEqual([
      'systemPrompt',
      'userMessage',
      'turnProcess',
      'assistantMessage',
      'turnTail',
    ]);

    const prompt = nodes[0];
    expect(prompt).toMatchObject({
      kind: 'systemPrompt',
      requestIds: ['request-01'],
      providerId: 'deepseek',
      model: 'deepseek-reasoner',
    });
    const process = turnProcess(nodes);
    expect(process).toMatchObject({
      status: 'completed',
      hasStartBoundary: true,
      hasEndBoundary: true,
    });
    expect(process.children.map((child) => child.kind)).toEqual(['reasoning']);
    expect(process.children[0]).toMatchObject({
      key: 'reasoning:turn-01:step-01',
      content: 'Read the frozen context. Answer directly.',
      state: 'completed',
    });

    const answer = nodes.find((node) => node.kind === 'assistantMessage');
    expect(answer).toMatchObject({
      key: 'assistant:turn-01:step-01',
      state: 'completed',
      blocks: [
        { type: 'reasoning', text: 'Read the frozen context. Answer directly.' },
        { type: 'text', text: 'Hello! How can I help?' },
      ],
    });
    expect(nodes[nodes.length - 1]).toMatchObject({
      kind: 'turnTail',
      key: 'turn-tail:turn-01',
      stopReason: 'stop',
      stats: {
        turnCount: 1,
        stepCount: 1,
        requestCount: 1,
        modelDurationMs: 500,
        timeToFirstTokenMs: 200,
        timeToFirstTokenCount: 1,
        averageTimeToFirstTokenMs: 200,
        decodeDurationMs: 300,
        decodeTokens: 24,
        uncachedInputTokens: 56,
        cacheReadTokens: 64,
        cacheWriteTokens: 8,
        outputTokens: 24,
        reasoningTokens: 10,
        totalTokens: 144,
        tokensPerSecond: 80,
        usageComplete: true,
      },
    });
  });

  it('keeps direct answers free of synthetic reasoning', () => {
    const nodes = projectAgentChatNodes(agentSessionBaselineScenarios['direct-answer'].events);
    expect(turnProcess(nodes).children).toEqual([]);
    expect(nodes.find((node) => node.kind === 'assistantMessage')).toMatchObject({
      blocks: [{ type: 'text', text: 'Hello! How can I help?' }],
    });
  });

  it('shows one prompt across five request series and retains every request reference', () => {
    const events = Array.from({ length: 5 }, (_, index) => requestHeader(index));
    const initial = projectAgentChatNodes(events.slice(0, 1))[0];
    const nodes = projectAgentChatNodes(events);
    const prompts = nodes.filter((node) => node.kind === 'systemPrompt');

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      key: initial.key,
      firstSeq: 0,
      lastSeq: 4,
      timestamp: initial.timestamp,
      requestId: 'request-4',
      requestIds: events.map((event) => event.data.requestId),
      content: events[0].data.systemPrompt,
      toolSchemas: events[0].data.toolSchemas,
    });
    expect(projectAgentChatNodes(events.slice(2))[0].key).toBe(initial.key);
  });

  it('preserves prompt changes and subsequent reversions', () => {
    const changes = { systemPrompt: 'Updated execution policy.' };
    const events = [requestHeader(0), requestHeader(1, changes), requestHeader(2)];
    const prompts = projectAgentChatNodes(events).filter((node) => node.kind === 'systemPrompt');

    expect(prompts).toHaveLength(3);
    expect(new Set(prompts.map((node) => node.key)).size).toBe(3);
    expect(prompts.map((node) => ({ content: node.content, toolSchemas: node.toolSchemas })))
      .toEqual(events.map((event) => ({
        content: event.data.systemPrompt,
        toolSchemas: event.data.toolSchemas,
      })));
    expect(prompts.map((node) => node.requestIds)).toEqual([
      ['request-0'], ['request-1'], ['request-2'],
    ]);
  });

  it('reuses identical prompts across Turns', () => {
    const events = [requestHeader(0), { ...requestHeader(1), turnId: 'turn-02' }];
    const prompts = projectAgentChatNodes(events).filter((node) => node.kind === 'systemPrompt');

    expect(prompts.map((node) => node.turnId)).toEqual(['turn-01']);
    expect(prompts.map((node) => node.requestIds)).toEqual([['request-0', 'request-1']]);
  });

  it('keeps tool and model changes out of the system prompt rows', () => {
    const nodes = projectAgentChatNodes([
      requestHeader(0),
      requestHeader(1, { toolSchemas: [], snapshotReason: 'change' }),
      requestHeader(2, { model: 'another-model', snapshotReason: 'change' }),
    ]);
    expect(nodes.filter((node) => node.kind === 'systemPrompt')).toHaveLength(1);
  });

  it.each(['resume', 'series'] as const)('shows an unchanged prompt at a %s boundary', (snapshotReason) => {
    const events = [requestHeader(0), requestHeader(1, { snapshotReason })];
    const prompts = projectAgentChatNodes(events).filter((node) => node.kind === 'systemPrompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[0].content).toBe(prompts[1].content);
    expect(prompts[0].key).not.toBe(prompts[1].key);
  });

  it('omits empty prompts and shows a prompt restored after removal', () => {
    const events = [requestHeader(0), requestHeader(1, { systemPrompt: '' }), requestHeader(2)];
    const prompts = projectAgentChatNodes(events).filter((node) => node.kind === 'systemPrompt');
    expect(prompts).toHaveLength(2);
    expect(prompts.every((node) => node.content !== '')).toBe(true);
  });

  it('keeps omitted usage unknown instead of projecting zeroes', () => {
    const nodes = projectAgentChatNodes(agentSessionBaselineScenarios['missing-usage'].events);
    expect(nodes[nodes.length - 1]).toMatchObject({
      kind: 'turnTail',
      usage: null,
      stats: {
        uncachedInputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        usageComplete: false,
      },
    });
  });

  it('projects every durable non-user provenance as context injection', () => {
    const nodes = projectAgentChatNodes(v4Fixture as unknown as readonly AgentSessionEvent[]);
    const process = turnProcess(nodes, 'turn-1');
    const context = process.children.filter((child) => child.kind === 'contextInjection');
    expect(context.map((node) => node.provenance.kind)).toEqual([
      'runtime',
      'plugin',
      'skill-catalog',
      'agent-instructions',
      'skill-invocation',
      'session-reference',
      'form',
    ]);
    expect(context.map((node) => node.key)).toEqual([
      'context:message-runtime',
      'context:message-plugin',
      'context:message-skill-catalog',
      'context:message-agent-instructions',
      'context:message-skill-invocation',
      'context:message-session-reference',
      'context:message-form',
    ]);
    expect(process).toMatchObject({ status: 'partial', hasStartBoundary: false });
  });

  it('keeps streaming reasoning and answer identities through final commit', () => {
    const events = agentSessionBaselineScenarios.hello.events;
    const reasoningIndexes = events.flatMap((event, index) => (
      event.type === 'assistant/chunk' && event.data.reasoningDelta ? [index] : []
    ));
    const textIndex = events.findIndex((event) => (
      event.type === 'assistant/chunk' && event.data.textDelta !== undefined
    ));
    const messageIndex = events.findIndex((event) => event.type === 'assistant/message');
    const first = projectAgentChatNodes(events.slice(0, reasoningIndexes[0] + 1));
    const second = projectAgentChatNodes(events.slice(0, reasoningIndexes[1] + 1));
    const streaming = projectAgentChatNodes(events.slice(0, textIndex + 1));
    const committed = projectAgentChatNodes(events.slice(0, messageIndex + 1));

    const firstReasoning = processChild(first, 'reasoning');
    const secondReasoning = processChild(second, 'reasoning');
    const streamingAnswer = streaming.find((node) => node.kind === 'assistantMessage');
    const committedAnswer = committed.find((node) => node.kind === 'assistantMessage');
    expect(secondReasoning).toMatchObject({
      key: firstReasoning?.key,
      content: 'Read the frozen context. Answer directly.',
      state: 'streaming',
    });
    expect(committedAnswer).toMatchObject({
      key: streamingAnswer?.key,
      state: 'completed',
      blocks: expect.arrayContaining([{ type: 'text', text: 'Hello! How can I help?' }]),
    });
  });

  it('nests ordered tool, approval, retry, and failure diagnostics in Turn Process', () => {
    const toolNodes = projectAgentChatNodes(agentSessionEventFixture);
    const toolProcess = turnProcess(toolNodes, 'turn-1');
    expect(toolProcess.children.map((child) => child.kind)).toEqual([
      'retry',
      'assistantMessage',
      'tool',
      'approvalMarker',
    ]);
    expect(processChild(toolNodes, 'tool', 'turn-1')).toMatchObject({
      key: 'tool:turn-1:step-1:call-health',
      state: 'succeeded',
      durationMs: 220,
    });

    const pending = projectAgentChatNodes(agentSessionWaitingApprovalEventFixture);
    expect(processChild(pending, 'approvalMarker', 'turn-1')).toMatchObject({
      status: 'requested',
    });
    expect(processChild(pending, 'tool', 'turn-1')).toMatchObject({ state: 'approval' });

    const retry = projectAgentChatNodes(agentSessionBaselineScenarios['retry-success'].events);
    expect(processChild(retry, 'retry')).toMatchObject({
      requestId: 'request-02',
      previousRequestId: 'request-01',
      attempt: 2,
    });

    const failed = projectAgentChatNodes(agentSessionBaselineScenarios['provider-error'].events);
    expect(turnProcess(failed)).toMatchObject({ status: 'failed' });
    expect(processChild(failed, 'error')).toMatchObject({
      state: 'failed',
      message: 'Fixture provider unavailable.',
    });

    const cancelled = projectAgentChatNodes(agentSessionBaselineScenarios.cancelled.events);
    expect(turnProcess(cancelled)).toMatchObject({ status: 'cancelled' });
    expect(cancelled.find((node) => node.kind === 'assistantMessage')).toMatchObject({
      state: 'interrupted',
    });
    expect(cancelled[cancelled.length - 1]).toMatchObject({
      kind: 'turnTail', status: 'cancelled',
    });
  });

  it('does not expose Agent, Turn, Step, or Request lifecycle as chat copy', () => {
    const nodes = projectAgentChatNodes(agentSessionAllEventFamiliesFixture);
    const topKinds = new Set<string>(nodes.map((node) => node.kind));
    expect(topKinds.has('lifecycleMarker')).toBe(false);
    expect(topKinds.has('turnStats')).toBe(false);
    expect(nodes.some((node) => node.key.startsWith('marker:'))).toBe(false);
    expect(turnProcess(nodes, 'turn-1').children.some((child) => child.key.startsWith('marker:')))
      .toBe(false);
  });

  it('keeps missing boundaries partial and never emits a misleading completed tail', () => {
    const completeSecondTurn = agentSessionBaselineScenarios['partial-history'].events;
    const missingStart = completeSecondTurn.slice(1);
    const nodes = projectAgentChatNodes(missingStart);
    expect(turnProcess(nodes, 'turn-02')).toMatchObject({
      status: 'partial',
      hasStartBoundary: false,
      hasEndBoundary: true,
    });
    expect(nodes.some((node) => node.kind === 'turnTail')).toBe(false);
  });

  it('preserves existing keys across pagination prepend and converges to full replay', () => {
    const scenario = agentSessionBaselineScenarios.pagination;
    const pages = scenario.pages;
    expect(pages).toBeDefined();
    if (!pages) return;
    const current = projectAgentChatNodes(pages.current);
    const prepended = projectAgentChatNodes([...pages.older, ...pages.current]);
    const full = projectAgentChatNodes(scenario.events);
    expect(prepended).toEqual(full);
    const fullKeys = new Set(projectionKeys(full));
    expect(projectionKeys(current).every((key) => fullKeys.has(key))).toBe(true);
  });

  it('keeps per-Turn stats stable across pagination and marks incomplete session totals', () => {
    const scenario = agentSessionBaselineScenarios.pagination;
    const pages = scenario.pages;
    expect(pages).toBeDefined();
    if (!pages) return;
    const current = projectAgentChatNodes(pages.current);
    const full = projectAgentChatNodes(scenario.events);
    const currentTail = current.find((node) => node.kind === 'turnTail');
    const fullTail = full.find((node) => node.kind === 'turnTail' && node.turnId === 'turn-02');

    expect(currentTail).toMatchObject({
      kind: 'turnTail',
      stats: fullTail?.kind === 'turnTail' ? fullTail.stats : undefined,
      sessionStats: { historyComplete: false, turnCount: 1 },
    });
    expect(fullTail).toMatchObject({
      kind: 'turnTail',
      sessionStats: { historyComplete: true, turnCount: 2 },
    });
  });

  it('uses the same raw timing and usage facts for Turn and session stats', () => {
    const nodes = projectAgentChatNodes(agentSessionBaselineScenarios.hello.events);
    const tail = nodes.find((node) => node.kind === 'turnTail');
    expect(tail?.kind).toBe('turnTail');
    if (tail?.kind !== 'turnTail') return;

    expect(tail.sessionStats).toEqual(aggregateDurableSessionStats([tail.stats]));
    expect(tail.sessionStats).toMatchObject({
      turnCount: 1,
      stepCount: tail.stats.stepCount,
      modelDurationMs: tail.stats.modelDurationMs,
      toolDurationMs: tail.stats.toolDurationMs,
      averageTimeToFirstTokenMs: tail.stats.averageTimeToFirstTokenMs,
      tokensPerSecond: tail.stats.tokensPerSecond,
      uncachedInputTokens: tail.stats.uncachedInputTokens,
      cacheReadTokens: tail.stats.cacheReadTokens,
      cacheWriteTokens: tail.stats.cacheWriteTokens,
      outputTokens: tail.stats.outputTokens,
      reasoningTokens: tail.stats.reasoningTokens,
    });
  });

  it('does not change projected stats when compaction diagnostics append', () => {
    const events = agentSessionBaselineScenarios.hello.events;
    const last = events[events.length - 1];
    const compacted = [
      ...events,
      {
        version: 5, sessionId: last.sessionId, seq: last.seq + 1,
        timeUnixMs: last.timeUnixMs + 100, type: 'compaction/start',
        data: { reason: 'fixture pressure' },
      },
      {
        version: 5, sessionId: last.sessionId, seq: last.seq + 2,
        timeUnixMs: last.timeUnixMs + 200, type: 'compaction/summary',
        data: { summary: 'fixture summary', replacedThroughSeq: 6, surfaceGeneration: 1 },
      },
      {
        version: 5, sessionId: last.sessionId, seq: last.seq + 3,
        timeUnixMs: last.timeUnixMs + 300, type: 'compaction/end',
        data: { surfaceGeneration: 1, replacedThroughSeq: 6, status: 'completed' },
      },
    ] as readonly AgentSessionEvent[];
    const before = projectAgentChatNodes(events).find((node) => node.kind === 'turnTail');
    const after = projectAgentChatNodes(compacted).find((node) => node.kind === 'turnTail');

    expect(after).toEqual(before);
  });

  it('orders multiple nodes derived from one event deterministically', () => {
    const hello = agentSessionBaselineScenarios.hello.events;
    const selected = [
      hello.find((event) => event.type === 'turn/start'),
      hello.find((event) => event.type === 'request/header'),
      hello.find((event) => event.type === 'assistant/message'),
    ].filter((event) => event !== undefined)
      .map((event, seq) => ({
        ...event,
        seq,
        timeUnixMs: 1_000 + seq * 100,
      })) as readonly AgentSessionEvent[];
    const nodes = projectAgentChatNodes(selected);
    const processIndex = nodes.findIndex((node) => node.kind === 'turnProcess');
    const answerIndex = nodes.findIndex((node) => node.kind === 'assistantMessage');
    const process = turnProcess(nodes);
    expect(process.children).toEqual([
      expect.objectContaining({ kind: 'reasoning', firstSeq: 2, lastSeq: 2 }),
    ]);
    expect(nodes[answerIndex]).toMatchObject({ firstSeq: 2, lastSeq: 2 });
    expect(processIndex).toBeLessThan(answerIndex);
  });

  it('is replay-idempotent and rejects invalid committed windows', () => {
    for (const scenario of Object.values(agentSessionBaselineScenarios)) {
      const first = projectAgentChatNodes(structuredClone(scenario.events));
      const second = projectAgentChatNodes(structuredClone(scenario.events));
      expect(projectionKeys(first)).toEqual(projectionKeys(second));
      expect(first).toEqual(second);
    }
    expect(projectAgentChatNodes(agentSessionEventFixture))
      .toEqual(projectAgentChatNodes(agentSessionEventFixture));
    expect(() => projectAgentChatNodes([
      agentSessionEventFixture[0],
      { ...agentSessionEventFixture[1], seq: 2 },
    ])).toThrow('ordered and contiguous');
    const old = agentSessionEventFixture.map((event) => ({
      ...event,
      version: 3,
    })) as unknown as readonly AgentSessionEvent[];
    expect(() => projectAgentChatNodes(old)).toThrow('Unsupported Agent Session event version');
  });

  it('keeps future audit-only events out of Conversation', () => {
    const unknownEvent = {
      ...agentSessionEventFixture[0],
      type: 'future/safe-extension',
      data: { status: 'completed' },
    } as unknown as AgentSessionEvent;
    expect(projectAgentChatNodes([unknownEvent])).toEqual([]);
  });
});
