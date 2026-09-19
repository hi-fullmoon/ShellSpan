import { describe, expect, it } from 'vitest';
import { createAgentChatProjector, projectAgentChatNodes } from '../conversation-projection';
import { createAgentActivityProjector, projectAgentActivity } from '../agent-session-projection';
import { createQuestionProjector, projectQuestions } from '../question-projection';
import { agentSessionBaselineScenarios } from '@/test/fixtures/agent-session-baseline';
import { agentSessionAllEventFamiliesFixture, agentSessionFailedEventFixture } from '@/test/fixtures/agent-session';

const windows = [
  ...Object.values(agentSessionBaselineScenarios).map(({ events }) => events),
  agentSessionAllEventFamiliesFixture,
  agentSessionFailedEventFixture,
];

describe('incremental committed projections', () => {
  for (const [name, create, replay] of [
    ['chat', createAgentChatProjector, projectAgentChatNodes],
    ['activity', createAgentActivityProjector, projectAgentActivity],
    ['questions', createQuestionProjector, projectQuestions],
  ] as const) {
    it(`${name}: every streamed prefix matches full replay without mutating earlier views`, () => {
      for (const events of windows) {
        const project = create();
        let previous = project([]);
        for (let length = 1; length <= events.length; length += 1) {
          const before = structuredClone(previous);
          const prefix = events.slice(0, length);
          const next = project(prefix);
          expect(previous).toEqual(before);
          expect(next).toEqual(replay(prefix));
          expect(project([...prefix])).toBe(next);
          previous = next;
        }
      }
    });

    it(`${name}: resets for truncated, replaced, paginated and different-session windows`, () => {
      const project = create();
      for (const events of windows) {
        for (const window of [events, events.slice(0, 3), events, structuredClone(events), events.slice(3)]) {
          expect(project(window)).toEqual(replay(window));
        }
      }
    });

    it(`${name}: rejects a gap at the append boundary and accepts a repaired stream`, () => {
      const events = agentSessionAllEventFamiliesFixture;
      const project = create();
      project(events.slice(0, 2));
      expect(() => project([events[0], events[1], events[3]])).toThrow(/contiguous/);
      expect(project(events)).toEqual(replay(events));
    });
  }

  it('preserves unchanged user and assistant node references while later events arrive', () => {
    const events = agentSessionBaselineScenarios.hello.events;
    const project = createAgentChatProjector();
    let previous = project([]);
    for (let length = 1; length <= events.length; length += 1) {
      const next = project(events.slice(0, length));
      for (const node of next) {
        if (node.kind !== 'userMessage' && node.kind !== 'assistantMessage') continue;
        const before = previous.find((candidate) => candidate.key === node.key);
        if (before && before.lastSeq === node.lastSeq
          && (node.kind === 'userMessage'
            || (before.kind === 'assistantMessage' && !node.hasTurnTail && !before.hasTurnTail))) {
          expect(node).toBe(before);
        }
      }
      previous = next;
    }
  });
});
