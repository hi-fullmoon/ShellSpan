import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiConversationNodeList, aiAskConversationNodeRenderers } from '../workspace/ai-conversation-node-seat';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AiReasoningNode, AiToolNode, AiTurnProcessNode } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentSessionEvent } from '@/types/agent-session';

function makeEvent<Type extends AgentSessionEvent['type']>(
  seq: number,
  timeUnixMs: number,
  type: Type,
  data: Extract<AgentSessionEvent, { type: Type }>['data'],
  extra: Partial<AgentSessionEvent> = {},
): AgentSessionEvent {
  return {
    version: 5,
    sessionId: 'session-live-status',
    seq,
    timeUnixMs,
    type,
    data,
    ...extra,
  } as AgentSessionEvent;
}

function makeTool(overrides: Partial<AiToolNode> = {}): AiToolNode {
  return {
    kind: 'tool',
    key: 'tool:call-1',
    sourceKind: 'agent',
    sessionId: 'session-live-status',
    turnId: 'turn-1',
    stepId: 'step-1',
    firstSeq: 2,
    lastSeq: 3,
    timestamp: new Date().toISOString(),
    callId: 'call-1',
    name: 'run_terminal_command',
    nativeName: 'terminal_execute',
    title: null,
    summary: '',
    state: 'running',
    effect: 'readOnly',
    durationMs: null,
    detailRef: { kind: 'agentTool', sessionId: 'session-live-status', callId: 'call-1', turnId: 'turn-1', stepId: 'step-1' },
    evidenceRefs: [],
    input: { command: 'kubectl get pods -n prod --watch' },
    output: null,
    error: null,
    target: null,
    idempotency: 'yes',
    approval: null,
    ...overrides,
  };
}

function makeProcess(overrides: Partial<AiTurnProcessNode> = {}): AiTurnProcessNode {
  const now = Date.now();
  return {
    kind: 'turnProcess',
    key: 'turn-process:turn-1',
    sourceKind: 'agent',
    sessionId: 'session-live-status',
    turnId: 'turn-1',
    stepId: null,
    firstSeq: 1,
    lastSeq: 4,
    timestamp: new Date(now).toISOString(),
    startedAtUnixMs: now,
    status: 'running',
    answerGeneration: 'req-1',
    hasStartBoundary: true,
    hasEndBoundary: false,
    childKeys: [],
    children: [],
    ...overrides,
  };
}

describe('reasoning duration and live turn process status', () => {
  beforeEach(async () => {
    useAppStore.setState({ locale: 'en-US' });
    await initI18n('en-US');
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('projects reasoning duration from streaming chunks and preserves settled duration on completion', () => {
    const t0 = 1_700_000_000_000;
    const events: AgentSessionEvent[] = [
      makeEvent(0, t0, 'turn/start', undefined, { turnId: 'turn-1' }),
      makeEvent(1, t0 + 100, 'assistant/chunk', { requestId: 'req-1', reasoningDelta: 'Checking pods' }, { turnId: 'turn-1', stepId: 'step-1' }),
      makeEvent(2, t0 + 6_900, 'assistant/chunk', { requestId: 'req-1', textDelta: 'Pods are healthy.' }, { turnId: 'turn-1', stepId: 'step-1' }),
      makeEvent(3, t0 + 14_000, 'assistant/message', {
        messageId: 'msg-1',
        content: [
          { type: 'reasoning', text: 'Checking pods' },
          { type: 'text', text: 'Pods are healthy.' },
        ],
        usage: { uncachedInputTokens: 10, outputTokens: 10, totalTokens: 20 },
        stopReason: 'stop',
        interrupted: false,
      }, { turnId: 'turn-1', stepId: 'step-1' }),
    ];

    const nodes = projectAgentChatNodes(events);
    const process = nodes.find((node): node is AiTurnProcessNode => node.kind === 'turnProcess')!;
    const reasoning = process.children.find((child): child is AiReasoningNode => child.kind === 'reasoning')!;
    expect(reasoning.startedAtUnixMs).toBe(t0 + 100);
    // Settled when answer text started (6.8s), not when the full reply finished (13.9s).
    expect(reasoning.durationMs).toBe(6_800);
    expect(process.startedAtUnixMs).toBe(t0);
  });

  it('leaves reasoning duration null when history has only a committed message without streaming chunks', () => {
    const t0 = 1_700_000_000_000;
    const events: AgentSessionEvent[] = [
      makeEvent(0, t0, 'turn/start', undefined, { turnId: 'turn-1' }),
      makeEvent(1, t0 + 5_000, 'assistant/message', {
        messageId: 'msg-1',
        content: [
          { type: 'reasoning', text: 'Checked directly' },
          { type: 'text', text: 'Done.' },
        ],
        usage: { uncachedInputTokens: 10, outputTokens: 10, totalTokens: 20 },
        stopReason: 'stop',
        interrupted: false,
      }, { turnId: 'turn-1', stepId: 'step-1' }),
    ];

    const nodes = projectAgentChatNodes(events);
    const process = nodes.find((node): node is AiTurnProcessNode => node.kind === 'turnProcess')!;
    const reasoning = process.children.find((child): child is AiReasoningNode => child.kind === 'reasoning')!;
    expect(reasoning.durationMs).toBeNull();
  });

  it('ticks reasoning elapsed time outside aria-live, pauses when hidden, and announces once on completion', () => {
    vi.useFakeTimers();
    const start = new Date('2026-11-22T12:00:00.000Z').getTime();
    vi.setSystemTime(start);

    const streamingNode: AiReasoningNode = {
      kind: 'reasoning',
      key: 'reasoning:turn-1:step-1',
      sourceKind: 'agent',
      sessionId: 'session-live-status',
      turnId: 'turn-1',
      stepId: 'step-1',
      firstSeq: 1,
      lastSeq: 1,
      timestamp: new Date(start).toISOString(),
      startedAtUnixMs: start,
      durationMs: null,
      requestId: 'req-1',
      summary: 'Inspecting cluster state',
      content: 'Inspecting cluster state',
      state: 'streaming',
    };

    const { container, rerender } = render(
      <AiConversationNodeList nodes={[streamingNode]} renderers={aiAskConversationNodeRenderers} />,
    );

    expect(container.querySelector('[data-ai-elapsed-timer]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    const timer = container.querySelector('[data-ai-elapsed-timer]');
    expect(timer).toHaveTextContent('3s');
    expect(timer).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('[aria-live="polite"]')).toBeNull();

    // Pause ticking while document is hidden
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(5_000);
    });
    expect(container.querySelector('[data-ai-elapsed-timer]')).toHaveTextContent('3s');

    // Resume and catch up when visible again
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(container.querySelector('[data-ai-elapsed-timer]')).toHaveTextContent('8s');

    // Complete -> show settled duration and announce once
    rerender(
      <AiConversationNodeList
        nodes={[{ ...streamingNode, lastSeq: 2, state: 'completed', durationMs: 6_800 }]}
        renderers={aiAskConversationNodeRenderers}
      />,
    );
    expect(container.querySelector('[data-ai-elapsed-timer]')).toBeNull();
    expect(container.querySelector('[data-ai-reasoning-duration]')).toHaveTextContent('6.8s');
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('Thought for 6.8s');
  });

  it('updates the running turn process summary as tool states progress and clears on completion', async () => {
    vi.useFakeTimers();
    const start = new Date('2026-11-22T12:00:00.000Z').getTime();
    vi.setSystemTime(start);

    const preparingTool = makeTool({
      name: 'write_file',
      nativeName: 'write_file',
      state: 'preparing',
      input: { path: '/etc/nginx/nginx.conf' },
    });
    const process = makeProcess({
      startedAtUnixMs: start,
      timestamp: new Date(start).toISOString(),
      children: [preparingTool],
      childKeys: [preparingTool.key],
    });

    const { container, rerender } = render(<AiConversationNodeList nodes={[process]} />);
    const summaryEl = () => container.querySelector('.ai-turn-process-trigger .ai-disclosure-summary');
    expect(summaryEl()).toHaveTextContent('Preparing Write: /etc/nginx/nginx.conf');
    expect(summaryEl()).toHaveAttribute('title', 'Preparing Write: /etc/nginx/nginx.conf');

    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(container.querySelector('.ai-turn-process-trigger [data-ai-elapsed-timer]')).toHaveTextContent('12s');

    const runningTool = makeTool({
      key: 'tool:call-2',
      callId: 'call-2',
      state: 'running',
      lastSeq: 5,
      input: { command: 'kubectl get pods -n prod --watch' },
    });
    rerender(<AiConversationNodeList nodes={[makeProcess({
      lastSeq: 5,
      startedAtUnixMs: start,
      children: [{ ...preparingTool, state: 'succeeded', lastSeq: 4 }, runningTool],
      childKeys: [preparingTool.key, runningTool.key],
    })]} />);
    expect(summaryEl()).toHaveTextContent('Command: kubectl get pods -n prod --watch');
    expect(summaryEl()).toHaveAttribute('data-ai-live-action', '');

    rerender(<AiConversationNodeList nodes={[makeProcess({
      lastSeq: 6,
      status: 'completed',
      hasEndBoundary: true,
      startedAtUnixMs: start,
      children: [{ ...preparingTool, state: 'succeeded', lastSeq: 4 }, { ...runningTool, state: 'succeeded', lastSeq: 6 }],
      childKeys: [preparingTool.key, runningTool.key],
    })]} />);
    expect(container.querySelector('.ai-turn-process-trigger [data-ai-elapsed-timer]')).toBeNull();
    expect(summaryEl()).toHaveTextContent('2 tools');
    expect(summaryEl()).not.toHaveAttribute('data-ai-live-action');
  });

  it('does not mirror streaming reasoning text into the turn process header line', () => {
    const start = new Date('2026-11-22T12:00:00.000Z').getTime();
    const streamingReasoning: AiReasoningNode = {
      kind: 'reasoning',
      key: 'reasoning:turn-1:step-2',
      sourceKind: 'agent',
      sessionId: 'session-live-status',
      turnId: 'turn-1',
      stepId: 'step-2',
      firstSeq: 3,
      lastSeq: 3,
      timestamp: new Date(start).toISOString(),
      startedAtUnixMs: start,
      durationMs: null,
      requestId: 'req-2',
      summary: 'Now, important decision: inspect /var/log',
      content: 'Now, important decision: inspect /var/log',
      state: 'streaming',
    };

    const { container, rerender } = render(
      <AiConversationNodeList
        nodes={[makeProcess({
          startedAtUnixMs: start,
          children: [streamingReasoning],
          childKeys: [streamingReasoning.key],
        })]}
      />,
    );
    expect(container.querySelector('.ai-turn-process-trigger .ai-disclosure-summary')).toBeNull();

    const completedTool = makeTool({ state: 'succeeded', lastSeq: 2 });
    rerender(
      <AiConversationNodeList
        nodes={[makeProcess({
          lastSeq: 3,
          startedAtUnixMs: start,
          children: [completedTool, streamingReasoning],
          childKeys: [completedTool.key, streamingReasoning.key],
        })]}
      />,
    );
    const summaryEl = container.querySelector('.ai-turn-process-trigger .ai-disclosure-summary');
    expect(summaryEl).toHaveTextContent('1 tool');
    expect(summaryEl).not.toHaveAttribute('data-ai-live-action');
    expect(summaryEl?.textContent).not.toContain('important decision');
  });

  it('aligns streaming reasoning timer spacing without a leading dot separator', () => {
    vi.useFakeTimers();
    const start = new Date('2026-11-22T12:00:00.000Z').getTime();
    vi.setSystemTime(start);

    const streamingReasoning: AiReasoningNode = {
      kind: 'reasoning',
      key: 'reasoning:turn-1:step-1',
      sourceKind: 'agent',
      sessionId: 'session-live-status',
      turnId: 'turn-1',
      stepId: 'step-1',
      firstSeq: 1,
      lastSeq: 1,
      timestamp: new Date(start).toISOString(),
      startedAtUnixMs: start,
      durationMs: null,
      requestId: 'req-1',
      summary: 'Inspecting logs',
      content: 'Inspecting logs',
      state: 'streaming',
    };

    const { container } = render(<AiConversationNodeList nodes={[streamingReasoning]} />);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    const timer = container.querySelector('.ai-reasoning-row [data-ai-elapsed-timer]');
    expect(timer).toHaveTextContent('2s');
    expect(timer).toHaveClass('ml-1.5');
    expect(timer?.previousElementSibling).not.toHaveClass('ai-disclosure-separator');
  });

  it('formats tool row duration in ms below 1s and seconds/minutes at or above 1s', () => {
    const { container, rerender } = render(
      <AiConversationNodeList nodes={[makeTool({ state: 'succeeded', lastSeq: 3, durationMs: 420 })]} />,
    );
    expect(container.querySelector('.ai-tool-duration')).toHaveTextContent('420 ms');

    rerender(<AiConversationNodeList nodes={[makeTool({ state: 'succeeded', lastSeq: 4, durationMs: 1_842 })]} />);
    expect(container.querySelector('.ai-tool-duration')).toHaveTextContent('1.8s');

    rerender(<AiConversationNodeList nodes={[makeTool({ state: 'succeeded', lastSeq: 5, durationMs: 15_400 })]} />);
    expect(container.querySelector('.ai-tool-duration')).toHaveTextContent('15s');

    rerender(<AiConversationNodeList nodes={[makeTool({ state: 'succeeded', lastSeq: 6, durationMs: 65_000 })]} />);
    expect(container.querySelector('.ai-tool-duration')).toHaveTextContent('1m 5s');
  });
});
