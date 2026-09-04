import { describe, expect, it } from 'vitest';
import { projectAgentChatNodes } from '../conversation-projection';
import type { AiConversationNode } from '../conversation-node';
import { sessionEvent } from '@/test/fixtures/agent-session';
import { agentSessionBaselineScenarios } from '@/test/fixtures/agent-session-baseline';
import type { AgentSessionEvent } from '@/types/agent-session';

const scope = { turnId: 'turn-01', stepId: 'step-01' };
const reasoningEvents = agentSessionBaselineScenarios['streaming-reasoning'].events
  .map((event) => ({ ...event, sessionId: 'session-fixture' }));
const streamingEvents = [
  ...reasoningEvents,
  sessionEvent(reasoningEvents.length, {
    ...scope,
    type: 'assistant/chunk',
    data: { requestId: 'request-01', textDelta: 'Partial response' },
  }),
];

function flatten(nodes: readonly AiConversationNode[]): readonly AiConversationNode[] {
  return nodes.flatMap<AiConversationNode>((node) => (
    node.kind === 'turnProcess' ? [node, ...node.children] : [node]
  ));
}

describe('conversation terminal output state', () => {
  it.each(['step/end', 'turn/end', 'agent/status', 'session/ended'] as const)(
    'settles unfinished output at %s without an assistant message or request failure',
    (type) => {
      for (const status of ['failed', 'cancelled'] as const) {
        const reason = status === 'failed'
          ? 'runtimeFailure: assistant text block is invalid or exceeds 131072 bytes'
          : 'cancelled';
        const terminal: AgentSessionEvent = type === 'step/end' || type === 'turn/end'
          ? sessionEvent(streamingEvents.length, { ...scope, type, data: { reason } })
          : sessionEvent(streamingEvents.length, { type, data: { status, reason } });
        const before = flatten(projectAgentChatNodes(streamingEvents));
        const after = flatten(projectAgentChatNodes([...streamingEvents, terminal]));

        for (const kind of ['reasoning', 'assistantMessage'] as const) {
          const draft = before.find((node) => node.kind === kind)!;
          expect(draft).toMatchObject({ state: 'streaming' });
          expect(after.find((node) => node.kind === kind)).toMatchObject({
            ...draft,
            state: kind === 'reasoning' ? 'interrupted' : status,
            lastSeq: terminal.seq,
          });
        }
        expect(after.some((node) => 'state' in node && node.state === 'streaming')).toBe(false);
        if (type !== 'step/end') {
          expect(after.find((node) => node.kind === 'turnProcess')).toMatchObject({ status });
        }
        if (type === 'agent/status' || type === 'session/ended') {
          expect(after.find((node) => node.kind === 'turnProcess')).toMatchObject({ hasEndBoundary: false });
          expect(after.some((node) => node.kind === 'turnTail')).toBe(false);
        }
      }
    },
  );

  it.each(['completed', 'waitingForApproval'])(
    'does not imply uncommitted output completed at a %s boundary',
    (reason) => {
      const nodes = flatten(projectAgentChatNodes([
        ...streamingEvents,
        sessionEvent(streamingEvents.length, { ...scope, type: 'turn/end', data: { reason } }),
      ]));
      expect(nodes.filter((node) => node.kind === 'reasoning' || node.kind === 'assistantMessage'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'reasoning', state: 'interrupted' }),
          expect.objectContaining({ kind: 'assistantMessage', state: 'interrupted' }),
        ]));
    },
  );

  it('settles only the ending step and preserves the next step as streaming', () => {
    const events = [
      ...streamingEvents,
      sessionEvent(streamingEvents.length, {
        turnId: scope.turnId, stepId: 'step-02', type: 'assistant/chunk',
        data: { requestId: 'request-02', reasoningDelta: 'Next step reasoning' },
      }),
      sessionEvent(streamingEvents.length + 1, {
        ...scope, type: 'step/end', data: { reason: 'runtimeFailure' },
      }),
    ];
    const nodes = flatten(projectAgentChatNodes(events));
    expect(nodes.find((node) => node.kind === 'reasoning' && node.stepId === 'step-01'))
      .toMatchObject({ state: 'interrupted' });
    expect(nodes.find((node) => node.kind === 'reasoning' && node.stepId === 'step-02'))
      .toMatchObject({ state: 'streaming' });
  });

  it('preserves committed content when a later runtime failure ends the session', () => {
    const events = agentSessionBaselineScenarios.hello.events
      .map((event) => ({ ...event, sessionId: 'session-fixture' }));
    const before = flatten(projectAgentChatNodes(events))
      .filter((node) => node.kind === 'reasoning' || node.kind === 'assistantMessage');
    const after = flatten(projectAgentChatNodes([
      ...events,
      sessionEvent(events.length, {
        type: 'session/ended', data: { status: 'failed', reason: 'runtimeFailure' },
      }),
    ]));
    expect(after.filter((node) => node.kind === 'reasoning' || node.kind === 'assistantMessage'))
      .toEqual(before);
  });

  it('settles unscoped drafts when the session ends', () => {
    const nodes = projectAgentChatNodes([
      sessionEvent(0, {
        type: 'assistant/chunk',
        data: { requestId: 'unscoped', reasoningDelta: 'Thinking', textDelta: 'Partial' },
      }),
      sessionEvent(1, { type: 'session/ended', data: { status: 'cancelled' } }),
    ]);
    expect(nodes).toEqual([
      expect.objectContaining({ kind: 'assistantMessage', state: 'cancelled' }),
      expect.objectContaining({ kind: 'reasoning', state: 'interrupted' }),
    ]);
  });
});
