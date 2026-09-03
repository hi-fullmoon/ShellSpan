import { describe, expect, it } from 'vitest';
import { sessionEvent } from '@/test/fixtures/agent-session';
import { projectAgentChatNodes } from '../conversation-projection';
import { projectAgentActivityNodes } from '@/lib/agent-session-projection';
import type { AgentSessionEvent } from '@/types/agent-session';

const scope = { turnId: 'turn', stepId: 'step' };
const header = { providerId: 'p', model: 'm', systemPrompt: 'system', toolSchemas: [], reason: 'initial' as const, series: { seriesId: 'series', requestIndex: 0, startsSeries: true }, attempt: 1 };
const events: AgentSessionEvent[] = [
  sessionEvent(1, { ...scope, type: 'request/header', data: { ...header, requestId: 'failed' } }),
  sessionEvent(2, { ...scope, type: 'assistant/chunk', data: { requestId: 'failed', textDelta: 'discard text', reasoningDelta: 'discard reasoning', toolCallDelta: { index: 0, callId: 'incomplete', nameDelta: 'apply_patch', argumentsDelta: '{' } } }),
  sessionEvent(3, { ...scope, type: 'request/failure', data: { requestId: 'failed', attempt: 1, maxAttempts: 2, cumulativeDelayMs: 0, interrupted: true, failure: { kind: 'transport', message: 'connection lost' } } }),
  sessionEvent(4, { ...scope, type: 'request/retry', data: { requestId: 'success', previousRequestId: 'failed', attempt: 2, reason: 'transport', delayMs: 0 } }),
  sessionEvent(5, { ...scope, type: 'request/header', data: { ...header, requestId: 'success', attempt: 2, reason: 'retry', series: { seriesId: 'series', requestIndex: 1, startsSeries: false } } }),
  sessionEvent(6, { ...scope, type: 'assistant/chunk', data: { requestId: 'success', textDelta: 'clean text', reasoningDelta: 'clean reasoning' } }),
  sessionEvent(7, { ...scope, type: 'assistant/message', data: { messageId: 'message', content: [{ type: 'text', text: 'clean text' }, { type: 'reasoning', text: 'clean reasoning' }], interrupted: false, stopReason: 'stop', usage: {} } }),
];

describe('failed request projections', () => {
  it('withdraws failed drafts immediately and does not join them to the next streaming answer', () => {
    expect(JSON.stringify(projectAgentChatNodes(events.slice(0, 2)))).toContain('discard text');
    expect(JSON.stringify(projectAgentChatNodes(events.slice(0, 3)))).not.toContain('discard');
    for (const end of [6, 7]) {
      const nodes = projectAgentChatNodes(events.slice(0, end));
      expect(nodes.filter(node => node.kind === 'assistantMessage')).toHaveLength(1);
      expect(JSON.stringify(nodes)).toContain('clean text');
      expect(JSON.stringify(nodes)).not.toContain('discard');
    }
  });
  it('retains separate failed chunk and retry audit records and replays identically', () => {
    const audit = projectAgentActivityNodes(events);
    expect(audit.find(node => node.kind === 'assistantStream' && node.requestId === 'failed')).toMatchObject({ status: 'interrupted' });
    expect(JSON.stringify(audit)).toContain('discard text');
    expect(audit.some(node => node.kind === 'retry')).toBe(true);
    expect(projectAgentChatNodes(JSON.parse(JSON.stringify(events)))).toEqual(projectAgentChatNodes(events));
    expect(projectAgentActivityNodes(JSON.parse(JSON.stringify(events)))).toEqual(audit);
  });
});
