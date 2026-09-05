import { describe, expect, it } from 'vitest';

import { projectAgentActivity } from '@/lib/agent-session-projection';
import fixture from '@/test/fixtures/agent-session-v5.json';
import {
  AGENT_SESSION_EVENT_VERSION,
  isSupportedAgentSessionEventVersion,
  type AgentSessionEvent,
  type AgentSessionProvenanceKind,
  type AgentSessionTokenUsage,
} from '@/types/agent-session';

const events = fixture as unknown as readonly AgentSessionEvent[];

describe('Agent Session Event v5 cross-language fixture', () => {
  it('round-trips the canonical JSON fields without loss', () => {
    const roundTripped = JSON.parse(JSON.stringify(events)) as unknown;
    expect(roundTripped).toEqual(fixture);
    expect(events).toHaveLength(15);
    expect(events.every((event) => (
      event.version === AGENT_SESSION_EVENT_VERSION
      && isSupportedAgentSessionEventVersion(event.version)
    ))).toBe(true);
  });

  it('covers every structured provenance kind with durable display facts', () => {
    const sources = events.flatMap((event) => (
      event.type === 'user/message' ? [event.data.message.source] : []
    ));
    expect(sources.map((source) => source.kind)).toEqual<AgentSessionProvenanceKind[]>([
      'user',
      'runtime',
      'plugin',
      'skill-catalog',
      'agent-instructions',
      'skill-invocation',
      'session-reference',
      'form',
    ]);
    expect(sources.every((source) => source.label && source.producerId)).toBe(true);
    expect(sources.find((source) => source.kind === 'session-reference')?.metadata)
      .toEqual({ sessionId: 'session-parent' });
  });

  it('preserves unknown usage separately from provider-reported zero', () => {
    const unknown: AgentSessionTokenUsage = {};
    const message = events.find((event) => event.type === 'assistant/message');
    expect(message?.type).toBe('assistant/message');
    if (message?.type !== 'assistant/message') return;
    expect(Object.prototype.hasOwnProperty.call(unknown, 'uncachedInputTokens')).toBe(false);
    expect(message.data.usage.uncachedInputTokens).toBe(0);
    expect(message.data.usage.cacheWriteTokens).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(message.data.usage, 'uncachedInputTokens')).toBe(true);
  });

  it('derives TTFT, reasoning duration, and LLM duration from Runtime timestamps', () => {
    const request = projectAgentActivity(events).turns[0]?.steps[0]?.requests[0];
    expect(request).toMatchObject({
      requestId: 'request-1',
      startedAt: 1_800,
      firstReasoningAt: 1_900,
      firstTextAt: 2_100,
      completedAt: 2_500,
      ttftMs: 100,
      reasoningDurationMs: 200,
      llmDurationMs: 700,
      usage: {
        uncachedInputTokens: 0,
        cacheReadTokens: 64,
        cacheWriteTokens: 0,
      },
    });
  });

  it('rejects v2 and v3 windows before projecting any events', () => {
    for (const version of [2, 3]) {
      const old = events.map((event) => ({ ...event, version })) as unknown as AgentSessionEvent[];
      expect(() => projectAgentActivity(old)).toThrow('Unsupported Agent Session event version');
    }
  });
});
