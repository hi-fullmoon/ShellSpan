import { bench, describe } from 'vitest';

import { aiConversationNodeRevision } from '@/components/ai/workspace/ai-conversation-node-seat';
import { projectAgentConversationNodes } from '@/lib/ai/conversation-projection';
import { sessionEvent } from '@/test/fixtures/agent-session';

const events = Array.from({ length: 2_500 }, (_, index) => {
  const turnId = `turn-${index}`;
  const stepId = `step-${index}`;
  return [
    sessionEvent(index * 2, {
      type: 'user/message',
      turnId,
      stepId,
      data: {
        message: {
          messageId: `user-${index}`,
          clientSubmissionId: `submission-${index}`,
          content: `Goal ${index}`,
          source: { kind: 'user' },
        },
      },
    }),
    sessionEvent(index * 2 + 1, {
      type: 'assistant/message',
      turnId,
      stepId,
      data: {
        messageId: `assistant-${index}`,
        content: `Result ${index}`,
        toolCalls: [],
        interrupted: false,
      },
    }),
  ];
}).flat();

const nodes = projectAgentConversationNodes(events);

describe('AI panel long-conversation diagnostics', () => {
  bench('project a 5,000-message Agent restore into stable keyed nodes', () => {
    const restored = projectAgentConversationNodes(events);
    if (restored.length !== 5_000) throw new Error(`Expected 5,000 nodes, received ${restored.length}`);
  }, { iterations: 5, time: 500, warmupIterations: 1, warmupTime: 100 });

  bench('compute memo revisions for a 5,000-node render window', () => {
    const revisions = nodes.map(aiConversationNodeRevision);
    if (revisions.length !== 5_000) throw new Error('Node revision diagnostic lost rows');
  }, { iterations: 10, time: 500, warmupIterations: 2, warmupTime: 100 });

  bench('apply 20 streaming revisions without rebuilding historical node payloads', () => {
    const last = nodes[nodes.length - 1];
    if (!last || last.kind !== 'assistantMessage') throw new Error('Expected a terminal assistant node');
    for (let index = 1; index <= 20; index += 1) {
      aiConversationNodeRevision({ ...last, content: `${last.content}${'.'.repeat(index)}` });
    }
  }, { iterations: 20, time: 500, warmupIterations: 2, warmupTime: 100 });
});
