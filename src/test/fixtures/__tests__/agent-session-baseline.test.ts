import { describe, expect, it } from 'vitest';

import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import {
  AGENT_BASELINE_MODEL,
  AGENT_BASELINE_PERMISSION,
  AGENT_BASELINE_PROVIDER,
  AGENT_BASELINE_REASONING_LEVEL,
  AGENT_BASELINE_TIME_UNIX_MS,
  agentSessionBaselineScenarioIds,
  agentSessionBaselineScenarios,
} from '@/test/fixtures/agent-session-baseline';

describe('Agent Session Phase 0 deterministic baseline', () => {
  it('covers every frozen benchmark scenario without a provider request', () => {
    expect(agentSessionBaselineScenarioIds).toEqual([
      'hello',
      'direct-answer',
      'streaming-reasoning',
      'single-tool',
      'multiple-tools',
      'retry-success',
      'provider-error',
      'max-tokens',
      'cancelled',
      'partial-history',
      'pagination',
      'compaction',
      'missing-usage',
    ]);

    const all = agentSessionBaselineScenarios;
    expect(all.hello.modelInput.systemPrompt).toContain('frozen Phase 0 fixture');
    expect(all.hello.modelInput.context).toContain('/workspace/shellspan-fixture');
    expect(all['direct-answer'].events.some((event) => (
      event.type === 'assistant/message'
      && event.data.content.some((block) => block.type === 'reasoning')
    ))).toBe(false);
    expect(all['streaming-reasoning'].status).toBe('running');
    expect(all['single-tool'].events.filter((event) => event.type === 'tool/call')).toHaveLength(1);
    expect(all['multiple-tools'].events.filter((event) => event.type === 'tool/call')).toHaveLength(2);
    expect(all['retry-success'].events.some((event) => event.type === 'request/retry')).toBe(true);
    expect(all['provider-error'].events[all['provider-error'].events.length - 1]).toMatchObject({
      type: 'session/ended', data: { status: 'failed' },
    });
    expect(all['max-tokens'].events.some((event) => (
      event.type === 'request/usage' && event.data.finishReason === 'length'
    ))).toBe(true);
    expect(all.cancelled.events[all.cancelled.events.length - 1]).toMatchObject({
      type: 'session/ended', data: { status: 'cancelled' },
    });
    expect(all['partial-history'].events[0]?.seq).toBeGreaterThan(0);
    expect(all.pagination.pages?.older.length).toBeGreaterThan(0);
    expect(all.pagination.pages?.current.length).toBeGreaterThan(0);
    expect(all.compaction.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'compaction/start', 'compaction/summary', 'compaction/end',
    ]));
    expect(all.hello.expectedUsage).toMatchObject({
      uncachedInputTokens: 56,
      cacheReadTokens: 64,
      reasoningTokens: 10,
    });
    expect(all['missing-usage'].expectedUsage).toBeNull();
    expect(all['missing-usage'].events.some((event) => event.type === 'request/usage')).toBe(false);
  });

  it('fixes every event envelope and model-selection input', () => {
    for (const scenario of Object.values(agentSessionBaselineScenarios)) {
      expect(scenario.sessionId).toBe(`baseline-${scenario.id}`);
      expect(scenario.taskId).toBe(`task-${scenario.id}`);
      expect(scenario.modelInput).toMatchObject({
        provider: AGENT_BASELINE_PROVIDER,
        model: AGENT_BASELINE_MODEL,
        reasoningLevel: AGENT_BASELINE_REASONING_LEVEL,
        permission: AGENT_BASELINE_PERMISSION,
      });
      for (let index = 0; index < scenario.events.length; index += 1) {
        const event = scenario.events[index];
        expect(event.sessionId).toBe(scenario.sessionId);
        expect(event.seq).toBe((scenario.events[0]?.seq ?? 0) + index);
        expect(event.timeUnixMs).toBe(AGENT_BASELINE_TIME_UNIX_MS + event.seq * 100);
      }
    }
  });

  it('replays events and projected DOM inputs identically on consecutive runs', () => {
    for (const scenario of Object.values(agentSessionBaselineScenarios)) {
      const firstEvents = structuredClone(scenario.events);
      const secondEvents = structuredClone(scenario.events);
      expect(JSON.stringify(firstEvents)).toBe(JSON.stringify(secondEvents));
      expect(projectAgentChatNodes(firstEvents))
        .toEqual(projectAgentChatNodes(secondEvents));
    }
  });

  it('keeps pagination pages contiguous and reconstructs the full event stream', () => {
    const scenario = agentSessionBaselineScenarios.pagination;
    const pages = scenario.pages;
    expect(pages).toBeDefined();
    if (!pages) return;
    expect([...pages.older, ...pages.current]).toEqual(scenario.events);
    for (const page of [pages.older, pages.current]) {
      page.forEach((event, index) => {
        expect(event.seq).toBe((page[0]?.seq ?? 0) + index);
      });
    }
  });
});
