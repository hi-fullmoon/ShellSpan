import { describe, expect, it } from 'vitest';
import { createAgentChatProjector, projectAgentChatNodes } from '../conversation-projection';
import { withOptimisticConversationNodes } from '../optimistic-submission';
import { createAiComposerState, reduceAiComposer } from '../composer-machine';
import { projectAgentInbox } from '../agent-session-adapter';
import { inboxTimelineEvidence, inboxTimelineView } from '@/test/fixtures/agent-inbox-timeline';

const { events } = inboxTimelineEvidence;

describe('recorded Queue and Steer conversation lifecycle', () => {
  it('keeps busy submissions out of history until their durable consumption, including claim boundaries', () => {
    for (let length = 1; length <= events.length; length += 1) {
      const view = inboxTimelineView(length);
      const prefix = events.slice(0, length);
      for (const id of ['queued', 'correction', 'converted', 'new-turn-step']) {
        const consumed = prefix.some(event => event.type === 'user/message' && event.data.message.messageId === id);
        const users = view.nodes.filter(node => node.kind === 'userMessage' && node.messageId === id);
        expect(users.length, `${id} at prefix ${length}`).toBe(consumed ? 1 : 0);
        const item = view.inbox.find(candidate => candidate.id === id);
        if (item) expect(Boolean(item.consumed), `${id} consumption at prefix ${length}`).toBe(consumed);
      }
    }
  });

  it('interleaves corrections with completed work, then starts the queued turn after the only turn footer', () => {
    const nodes = projectAgentChatNodes(events);
    const sequence = nodes.flatMap(node => node.kind === 'userMessage' ? [node.messageId]
      : node.kind === 'turnTail' ? ['turn-end']
        : node.kind === 'turnProcess' ? node.children.flatMap(child => child.kind === 'tool' ? [child.callId] : []) : []);
    expect(sequence).toEqual(['initial', 'read-step-1', 'correction', 'read-step-2', 'converted', 'read-step-3', 'turn-end', 'queued', 'new-turn-step']);
    expect(nodes.flatMap(node => node.kind === 'userMessage' && node.inputKind === 'steer' ? [node.messageId] : []))
      .toEqual(['correction', 'converted']);
    expect(nodes.filter(node => node.kind === 'turnTail')).toHaveLength(1);
    expect(nodes.find(node => node.kind === 'turnTail')).toMatchObject({ stats: { toolCount: 3, stepCount: 3, turnCount: 1 } });
    const processes = nodes.filter(node => node.kind === 'turnProcess').filter(node => node.turnId === 'turn-1');
    expect(processes.map(node => node.hasStartBoundary)).toEqual([true, false, false]);
    expect(processes.map(node => node.hasEndBoundary)).toEqual([false, false, true]);
    expect(new Set(nodes.map(node => node.key)).size).toBe(nodes.length);
  });

  it('keeps streamed prefixes and restarted replay identical without mutating previous views', () => {
    const project = createAgentChatProjector();
    let previous = project([]);
    for (let length = 1; length <= events.length; length += 1) {
      const saved = structuredClone(previous);
      const prefix = events.slice(0, length);
      const next = project(prefix);
      expect(previous).toEqual(saved);
      expect(next).toEqual(projectAgentChatNodes(prefix));
      previous = next;
    }
  });

  it('recognizes an active turn even when older history does not include its start event', () => {
    const start = events.findIndex(event => event.type === 'tool/call');
    const end = events.findIndex(event => event.type === 'agent/inbox/item_steered');
    const window = events.slice(start, end + 1);
    expect(projectAgentChatNodes(window).some(node => node.kind === 'userMessage' && node.messageId === 'converted')).toBe(false);
    expect(projectAgentInbox(window).find(item => item.id === 'converted'))
      .toMatchObject({ lane: 'nextStep', startsTurn: false, state: 'queued' });
  });

  it.each(['queue', 'steer'] as const)('shows a %s submission only in the composer queue before acknowledgement', preferredBusyMode => {
    const state = createAiComposerState({ sessionId: 'session-1', runtimeStatus: 'running', phase: 'running', preferredBusyMode });
    const transition = reduceAiComposer(state, { type: 'submit.requested', content: '检查当前依赖',
      gesture: 'keyboard', accelerated: false, clientOperationId: 'submission', now: 1,
      hasProvider: true, canCreateSession: false });
    const pending = transition.state.pendingSubmissions[0];
    expect(pending).toBeDefined();
    expect(pending.startsTurn).toBe(false);
    expect(withOptimisticConversationNodes([], [{ ...pending, scopeKey: 'workbench', expectedNextSeq: null, delivery: 'pending' }],
      'workbench', 'session-1')).toEqual([]);
  });

  it('retains the immediate optimistic row when sending to an idle existing conversation', () => {
    const transition = reduceAiComposer(createAiComposerState({ sessionId: 'session-1' }), {
      type: 'submit.requested', content: '检查当前依赖', gesture: 'keyboard', accelerated: false,
      clientOperationId: 'submission', now: 1, hasProvider: true, canCreateSession: false,
    });
    const pending = transition.state.pendingSubmissions[0];
    expect(pending.startsTurn).toBe(true);
    expect(withOptimisticConversationNodes([], [{ ...pending, scopeKey: 'workbench', expectedNextSeq: null, delivery: 'pending' }],
      'workbench', 'session-1')).toHaveLength(1);
  });
});
