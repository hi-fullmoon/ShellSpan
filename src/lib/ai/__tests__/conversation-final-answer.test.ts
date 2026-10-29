import { describe, expect, it } from 'vitest';
import { createAgentChatProjector, projectAgentChatNodes } from '../conversation-projection';
import { conversationFoldRecording } from '@/test/fixtures/conversation-fold-runtime';

describe('recorded latest-step answer selection', () => {
  it('moves a provisional reply into process as soon as a later step starts', () => {
    const { events } = conversationFoldRecording.continued;
    const reply = events.findIndex(event => event.type === 'assistant/message');
    const nextStep = events.findIndex((event, index) => index > reply && event.type === 'step/start');
    const project = createAgentChatProjector();
    const before = project(events.slice(0, nextStep));
    const answer = before.find(node => node.kind === 'assistantMessage');
    expect(answer).toBeDefined();
    const after = project(events.slice(0, nextStep + 1));
    expect(after.some(node => node.kind === 'assistantMessage')).toBe(false);
    expect(after.find(node => node.kind === 'turnProcess')).toMatchObject({
      hasFinalAnswer: false,
      children: expect.arrayContaining([answer]),
    });
    // The final observed step calls tools, so the earlier text stays in process.
    expect(project(events).some(node => node.kind === 'assistantMessage')).toBe(false);
  });

  it('stops presenting progress as an answer when streamed tool intent arrives', () => {
    const { events } = conversationFoldRecording.progress;
    const tool = events.findIndex(event => event.type === 'assistant/chunk' && event.data.toolCallDelta);
    const before = projectAgentChatNodes(events.slice(0, tool));
    expect(before.some(node => node.kind === 'assistantMessage')).toBe(true);
    const after = projectAgentChatNodes(events.slice(0, tool + 1));
    expect(after.some(node => node.kind === 'assistantMessage')).toBe(false);
    expect(after.find(node => node.kind === 'turnProcess')).toMatchObject({
      children: expect.arrayContaining([expect.objectContaining({ kind: 'assistantMessage' })]),
    });
    expect(projectAgentChatNodes(events).some(node => node.kind === 'assistantMessage')).toBe(false);
    // A paged stream may omit its request header; tool intent is still enough.
    const text = events.findIndex(event => event.type === 'assistant/chunk' && event.data.textDelta);
    expect(projectAgentChatNodes(events.slice(text, tool + 1)).some(node => node.kind === 'assistantMessage')).toBe(false);
  });

  it.each(['direct', 'completed'] as const)('keeps the %s reply streaming through commitment and uses only it for copy', scenario => {
    const { events } = conversationFoldRecording[scenario];
    const message = [...events].reverse().find(event => event.type === 'assistant/message');
    if (!message || message.type !== 'assistant/message') throw new Error('Recorded answer is required');
    const text = message.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    const index = events.indexOf(message);
    const streaming = projectAgentChatNodes(events.slice(0, index)).find(node => node.kind === 'assistantMessage');
    const nodes = projectAgentChatNodes(events);
    expect(streaming).toMatchObject({ state: 'streaming', stepId: message.stepId });
    expect(nodes.find(node => node.kind === 'assistantMessage')).toMatchObject({
      key: streaming?.key, state: 'completed', stepId: message.stepId, hasTurnTail: true,
    });
    expect(nodes.find(node => node.kind === 'turnProcess')).toMatchObject({ hasFinalAnswer: true });
    expect(nodes.find(node => node.kind === 'turnTail')).toMatchObject({ summaryText: text });
  });

  it.each(['direct', 'progress', 'continued', 'completed'] as const)(
    'rebuilds every %s prefix identically to incremental projection without changing earlier views', scenario => {
      const { events } = conversationFoldRecording[scenario];
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
    },
  );
});
