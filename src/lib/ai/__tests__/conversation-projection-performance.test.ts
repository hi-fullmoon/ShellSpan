import { describe, expect, it } from 'vitest';
import {
  aggregateDurableSessionStats,
  createAgentChatProjector,
  projectAgentChatNodes,
} from '../conversation-projection';
import type { AiDurableSessionStats } from '../conversation-node';
import type { AgentSessionEvent } from '@/types/agent-session';
import { taskTokenBudgetEvidence } from '@/test/fixtures/task-token-budget';
import skillsCapture from '@/test/fixtures/agent-skills-runtime.json';

// Replay real Rust runtime captures through the production projector.
const captures = [
  taskTokenBudgetEvidence.events,
  taskTokenBudgetEvidence.continuedEvents,
  skillsCapture as unknown as readonly AgentSessionEvent[],
];

describe('incremental conversation projection', () => {
  it('matches a complete replay at every publication, including replaced windows', () => {
    for (const events of captures) {
      const project = createAgentChatProjector();
      for (let count = 1; count <= events.length; count += 1) {
        const window = events.slice(0, count);
        expect(project(window)).toEqual(projectAgentChatNodes(window));
      }
      const truncated = events.slice(0, Math.floor(events.length / 2));
      expect(project(truncated)).toEqual(projectAgentChatNodes(truncated));
      expect(project(events)).toEqual(projectAgentChatNodes(events));
      const paged = events.slice(Math.floor(events.length / 2));
      expect(project(paged)).toEqual(projectAgentChatNodes(paged));
    }
  });

  it('reuses completed turn nodes when the session resumes', () => {
    const events = taskTokenBudgetEvidence.continuedEvents;
    const resume = events.findIndex((event) => event.type === 'session/resumed');
    expect(resume).toBeGreaterThan(0);
    const project = createAgentChatProjector();
    const previous = project(events.slice(0, resume));
    const tail = previous.find((node) => node.kind === 'turnTail');
    expect(tail).toBeDefined();
    const process = previous.find((node) => node.kind === 'turnProcess' && node.turnId === tail?.turnId);
    const next = project(events.slice(0, resume + 1));
    expect(next.find((node) => node.key === tail?.key)).toBe(tail);
    expect(next.find((node) => node.key === process?.key)).toBe(process);
  });

  it('folds cumulative usage and timing without losing unknown values', () => {
    for (const orderedCaptures of [captures, [...captures].reverse()]) {
      const stats = orderedCaptures.flatMap((events) => projectAgentChatNodes(events)
        .flatMap((node) => node.kind === 'turnTail' ? [node.stats] : []));
      let prefix: AiDurableSessionStats | undefined;
      for (let index = 0; index < stats.length; index += 1) {
        prefix = aggregateDurableSessionStats(prefix ? [prefix, stats[index]] : [stats[index]]);
        expect(prefix).toEqual(aggregateDurableSessionStats(stats.slice(0, index + 1)));
      }
      expect(stats.length).toBeGreaterThan(0);
    }
  });
});
