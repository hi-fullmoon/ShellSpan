import { bench, describe } from 'vitest';

import { aiConversationNodeRevision } from '@/components/ai/workspace/ai-conversation-node-seat';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
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
          source: {
            kind: 'user',
            label: 'User',
            producerId: 'shellspan-user',
          },
        },
      },
    }),
    sessionEvent(index * 2 + 1, {
      type: 'assistant/message',
      turnId,
      stepId,
      data: {
        messageId: `assistant-${index}`,
        content: [{ type: 'text', text: `Result ${index}` }],
        usage: {},
        stopReason: 'stop',
        interrupted: false,
      },
    }),
  ];
}).flat();

const nodes = projectAgentChatNodes(events);

describe('AI panel long-conversation diagnostics', () => {
  bench('project a 5,000-message Agent restore into stable keyed nodes', () => {
    const restored = projectAgentChatNodes(events);
    if (restored.length !== 5_000) throw new Error(`Expected 5,000 nodes, received ${restored.length}`);
  }, { iterations: 5, time: 500, warmupIterations: 1, warmupTime: 100 });

  bench('compute memo revisions for a 5,000-node render window', () => {
    const revisions = nodes.map(aiConversationNodeRevision);
    if (revisions.length !== 5_000) throw new Error('Node revision diagnostic lost rows');
  }, { iterations: 10, time: 500, warmupIterations: 2, warmupTime: 100 });

  bench('reproject a 5,000-node window across 20 streaming revisions', () => {
    for (let index = 1; index <= 20; index += 1) {
      const streamed = projectAgentChatNodes([
        ...events.slice(0, -1),
        sessionEvent(events.length - 1, {
          type: 'assistant/chunk',
          turnId: 'turn-2499',
          stepId: 'step-2499',
          data: {
            requestId: 'request-2499',
            textDelta: `Result 2499${'.'.repeat(index)}`,
          },
        }),
      ]);
      if (streamed.length !== 5_000) {
        throw new Error(`Streaming projection lost rows: ${streamed.length}`);
      }
      const last = streamed[streamed.length - 1];
      if (!last || last.kind !== 'assistantMessage' || last.state !== 'streaming') {
        throw new Error('Streaming projection lost its final assistant state');
      }
    }
  }, { iterations: 5, time: 500, warmupIterations: 1, warmupTime: 100 });
});
