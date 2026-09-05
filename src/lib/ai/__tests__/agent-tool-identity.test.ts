import { describe, expect, it } from 'vitest';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { projectAgentActivityNodes } from '@/lib/ai/agent-session-projection';
import { sessionEvent } from '@/test/fixtures/agent-session';
import type { AgentSessionEvent } from '@/types/agent-session';

function repeatedCallEvents(secondTurn = false): AgentSessionEvent[] {
  const events: AgentSessionEvent[] = [];
  const push = (draft: Parameters<typeof sessionEvent>[1]) => {
    events.push(sessionEvent(events.length, draft));
  };
  push({ type: 'turn/start', turnId: 'turn-1' });
  for (const [index, count] of [3, 2].entries()) {
    const turnId = secondTurn && index === 1 ? 'turn-2' : 'turn-1';
    const stepId = `step-${index + 1}`;
    if (secondTurn && index === 1) {
      push({ type: 'turn/end', turnId: 'turn-1', data: { reason: 'completed' } });
      push({ type: 'turn/start', turnId });
    }
    push({ type: 'step/start', turnId, stepId });
    const calls = Array.from({ length: count }, (_, callIndex) => ({
      callId: `call-${callIndex + 1}`,
      name: 'run_terminal_command',
      arguments: { command: `check-${index + 1}-${callIndex + 1}` },
    }));
    push({
      type: 'assistant/message', turnId, stepId,
      data: {
        messageId: `message-${index + 1}`, usage: {}, stopReason: 'toolCalls', interrupted: false,
        content: [
          { type: 'text', text: index === 0 ? '检查运行状态。' : '再看看网络连接和服务健康状态。' },
          ...calls.map((call) => ({ type: 'toolCall' as const, call })),
        ],
      },
    });
    for (const call of calls) {
      push({ type: 'tool/call', turnId, stepId, data: { call } });
      push({
        type: 'tool/approval', turnId, stepId,
        data: { callId: call.callId, requestId: `request-${index + 1}`, status: 'approved' },
      });
      push({
        type: 'tool/execution', turnId, stepId,
        data: { callId: call.callId, status: 'dispatched', idempotency: 'yes' },
      });
      push({
        type: 'tool/result', turnId, stepId,
        data: {
          callId: call.callId, name: call.name, status: 'completed',
          summary: `result-${index + 1}-${call.callId}`, durationMs: 100 * (index + 1),
        },
      });
    }
    push({ type: 'step/end', turnId, stepId, data: { reason: 'toolsCompleted' } });
  }
  const turnId = secondTurn ? 'turn-2' : 'turn-1';
  push({
    type: 'assistant/message', turnId, stepId: 'step-3',
    data: {
      messageId: 'final', content: [{ type: 'text', text: '系统运行状态报告。' }],
      usage: {}, stopReason: 'stop', interrupted: false,
    },
  });
  push({ type: 'turn/end', turnId, data: { reason: 'completed' } });
  return events;
}

function chatTools(events: readonly AgentSessionEvent[]) {
  return projectAgentChatNodes(events)
    .flatMap((node) => node.kind === 'turnProcess' ? node.children : [])
    .filter((node) => node.kind === 'tool');
}

describe('provider call IDs repeated in later steps', () => {
  it.each([false, true])('preserves all commands and results (second turn: %s)', (secondTurn) => {
    const events = repeatedCallEvents(secondTurn);
    const tools = chatTools(events);
    expect(tools).toHaveLength(5);
    expect(new Set(tools.map((tool) => tool.key)).size).toBe(5);
    expect(tools.map((tool) => [tool.input, tool.output, tool.approval?.requestId])).toEqual([
      [{ command: 'check-1-1' }, 'result-1-call-1', 'request-1'],
      [{ command: 'check-1-2' }, 'result-1-call-2', 'request-1'],
      [{ command: 'check-1-3' }, 'result-1-call-3', 'request-1'],
      [{ command: 'check-2-1' }, 'result-2-call-1', 'request-2'],
      [{ command: 'check-2-2' }, 'result-2-call-2', 'request-2'],
    ]);
    const activity = projectAgentActivityNodes(events).filter((node) => node.kind === 'tool');
    expect(activity).toHaveLength(5);
    expect(activity.map((node) => node.eventTypes)).toEqual(Array.from({ length: 5 }, () => [
      'tool/call', 'tool/approval', 'tool/execution', 'tool/result',
    ]));
    const tails = projectAgentChatNodes(events).filter((node) => node.kind === 'turnTail');
    expect(tails[tails.length - 1]?.sessionStats).toMatchObject({ toolCount: 5, toolDurationMs: 700 });
  });

  it('retains earlier commands as a later call streams, and keeps keys on pagination', () => {
    const events = repeatedCallEvents();
    const nextCall = events.findIndex((event) => event.type === 'tool/call' && event.stepId === 'step-2');
    const earlier = chatTools(events.slice(0, nextCall));
    const streaming = chatTools(events.slice(0, nextCall + 1));
    expect(streaming).toHaveLength(4);
    expect(streaming.slice(0, 3)).toEqual(earlier);
    expect(streaming[streaming.length - 1]?.state).toBe('preparing');

    const result = events.findIndex((event) => event.type === 'tool/result' && event.stepId === 'step-2');
    const pageTools = chatTools(events.slice(result));
    const fullTools = chatTools(events);
    expect(pageTools).toHaveLength(2);
    expect(pageTools.map((tool) => tool.key)).toEqual(fullTools.slice(3).map((tool) => tool.key));
    expect(projectAgentActivityNodes(events.slice(result)).filter((node) => node.kind === 'tool')
      .map((node) => node.key)).toEqual(projectAgentActivityNodes(events)
      .filter((node) => node.kind === 'tool').slice(3).map((node) => node.key));
    expect(chatTools(structuredClone(events))).toEqual(fullTools);
  });
});
