import { describe, expect, it } from 'vitest';

import visualManifest from '../../../../docs/ai-panel-phase5/evidence/manifest.json';
import { projectAgentActivity } from '@/lib/agent-session-projection';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AiConversationNode } from '@/lib/ai/conversation-node';
import {
  agentSessionBaselineScenarios,
  type AgentSessionBaselineScenarioId,
} from '@/test/fixtures/agent-session-baseline';

type MatrixRow = Readonly<{
  label: string;
  fixture: AgentSessionBaselineScenarioId;
  activityEvent: string;
  visualScene: string;
  assertConversation: (nodes: readonly AiConversationNode[]) => void;
}>;

function processChildren(nodes: readonly AiConversationNode[]): readonly string[] {
  return nodes.flatMap((node) => node.kind === 'turnProcess'
    ? node.children.map((child) => child.kind)
    : []);
}

function assertAnswer(nodes: readonly AiConversationNode[]): void {
  expect(nodes.some((node) => node.kind === 'assistantMessage')).toBe(true);
}

const rows: readonly MatrixRow[] = [
  {
    label: 'hello', fixture: 'hello', activityEvent: 'request/header',
    visualScene: 'hello-400-light-collapsed-1x', assertConversation: assertAnswer,
  },
  {
    label: 'no reasoning', fixture: 'direct-answer', activityEvent: 'assistant/message',
    visualScene: 'direct-answer-400-light-completed-1x',
    assertConversation: (nodes) => {
      assertAnswer(nodes);
      expect(processChildren(nodes)).not.toContain('reasoning');
    },
  },
  {
    label: 'streaming reasoning', fixture: 'streaming-reasoning', activityEvent: 'assistant/chunk',
    visualScene: 'streaming-reasoning-400-light-2x',
    assertConversation: (nodes) => {
      expect(processChildren(nodes)).toContain('reasoning');
      expect(nodes.find((node) => node.kind === 'turnProcess')).toMatchObject({ status: 'running' });
    },
  },
  {
    label: 'single tool', fixture: 'single-tool', activityEvent: 'tool/result',
    visualScene: 'single-tool-720-light-expanded-1x',
    assertConversation: (nodes) => expect(processChildren(nodes).filter((kind) => kind === 'tool')).toHaveLength(1),
  },
  {
    label: 'multiple tools', fixture: 'multiple-tools', activityEvent: 'tool/result',
    visualScene: 'multiple-tools-720-light-expanded-1x',
    assertConversation: (nodes) => expect(processChildren(nodes).filter((kind) => kind === 'tool')).toHaveLength(2),
  },
  {
    label: 'retry', fixture: 'retry-success', activityEvent: 'request/retry',
    visualScene: 'retry-success-400-light-expanded-1x',
    assertConversation: (nodes) => expect(processChildren(nodes)).toContain('retry'),
  },
  {
    label: 'provider error', fixture: 'provider-error', activityEvent: 'session/ended',
    visualScene: 'provider-error-400-light-expanded-1x',
    assertConversation: (nodes) => expect(processChildren(nodes)).toContain('error'),
  },
  {
    label: 'cancelled', fixture: 'cancelled', activityEvent: 'session/ended',
    visualScene: 'cancelled-400-light-expanded-1x',
    assertConversation: (nodes) => expect(nodes.find((node) => node.kind === 'assistantMessage'))
      .toMatchObject({ state: 'interrupted' }),
  },
  {
    label: 'max tokens', fixture: 'max-tokens', activityEvent: 'request/usage',
    visualScene: 'max-tokens-400-light-completed-1x',
    assertConversation: (nodes) => expect(nodes.find((node) => node.kind === 'turnTail'))
      .toMatchObject({ stopReason: 'length' }),
  },
  {
    label: 'partial history', fixture: 'partial-history', activityEvent: 'turn/end',
    visualScene: 'partial-history-400-light-expanded-1x',
    assertConversation: (nodes) => {
      expect(nodes.find((node) => node.kind === 'turnProcess')).toMatchObject({ status: 'partial' });
      expect(nodes.some((node) => node.kind === 'turnTail')).toBe(false);
    },
  },
  {
    label: 'pagination prepend', fixture: 'pagination', activityEvent: 'turn/start',
    visualScene: 'pagination-560-light-completed-1x',
    assertConversation: (nodes) => expect(nodes.filter((node) => node.kind === 'userMessage')).toHaveLength(2),
  },
  {
    label: 'compaction', fixture: 'compaction', activityEvent: 'compaction/end',
    visualScene: 'compaction-400-light-completed-1x',
    assertConversation: (nodes) => {
      assertAnswer(nodes);
      expect(nodes.map((node) => String(node.kind))).not.toContain('lifecycleMarker');
    },
  },
  {
    label: 'complete cache usage', fixture: 'hello', activityEvent: 'request/usage',
    visualScene: 'hello-560-light-completed-1x',
    assertConversation: (nodes) => expect(nodes.find((node) => node.kind === 'turnTail'))
      .toMatchObject({
        stats: { cacheReadTokens: 64, cacheWriteTokens: 8, usageComplete: true },
      }),
  },
  {
    label: 'missing usage', fixture: 'missing-usage', activityEvent: 'assistant/message',
    visualScene: 'missing-usage-400-light-completed-1x',
    assertConversation: (nodes) => expect(nodes.find((node) => node.kind === 'turnTail'))
      .toMatchObject({
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
      }),
  },
];

const visualSceneIds = new Set(visualManifest.scenes.map((scene) => scene.id));

describe('AI Panel Phase 6 acceptance matrix', () => {
  it.each(rows)('$label has direct Event, Conversation, Activity, Stats, and Visual evidence', (row) => {
    const scenario = agentSessionBaselineScenarios[row.fixture];

    expect(scenario.events.length).toBeGreaterThan(0);
    expect(scenario.events.every((event) => event.version === 5)).toBe(true);
    expect(scenario.events.some((event) => event.type === row.activityEvent)).toBe(true);

    const conversation = projectAgentChatNodes(scenario.events);
    row.assertConversation(conversation);

    const activity = projectAgentActivity(scenario.events);
    expect(activity.nodes.length).toBeGreaterThan(0);
    expect(activity.nodes.some((node) => node.records.some((record) => (
      record.type === row.activityEvent
    )))).toBe(true);

    const tails = conversation.filter((node) => node.kind === 'turnTail');
    for (const tail of tails) {
      expect(tail.stats.turnCount).toBe(1);
      expect(tail.stats.stepCount).toBeGreaterThanOrEqual(1);
      for (const value of Object.values(tail.stats)) {
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
      }
    }
    if (row.fixture === 'streaming-reasoning' || row.fixture === 'partial-history') {
      expect(tails).toHaveLength(0);
    } else {
      expect(tails.length).toBeGreaterThan(0);
    }

    expect(visualSceneIds.has(row.visualScene)).toBe(true);
  });

  it('pagination prepend converges to the full replay without changing current keys', () => {
    const scenario = agentSessionBaselineScenarios.pagination;
    expect(scenario.pages).toBeDefined();
    if (!scenario.pages) return;
    const currentKeys = projectAgentChatNodes(scenario.pages.current).map((node) => node.key);
    const fullKeys = new Set(projectAgentChatNodes([
      ...scenario.pages.older,
      ...scenario.pages.current,
    ]).map((node) => node.key));
    expect(currentKeys.every((key) => fullKeys.has(key))).toBe(true);
  });
});
