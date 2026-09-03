import { bench, describe } from 'vitest';

import { aiConversationNodeRevision } from '@/components/ai/workspace/ai-conversation-node-seat';
import { projectAskConversationNodes } from '@/lib/ai/conversation-projection';
import {
  askStreamingConversationFixture,
  askStreamingMessageFixture,
} from '@/test/fixtures/ask-streaming';

const user = askStreamingMessageFixture.find((message) => message.role === 'user');
const assistant = askStreamingMessageFixture.find((message) => message.role === 'assistant');
if (!user || !assistant) throw new Error('Ask performance fixture is incomplete');

const messages = Array.from({ length: 2_500 }, (_, index) => {
  const requestId = `restore-${index}`;
  return [
    { ...user, id: `user-${index}`, requestId, content: `Question ${index}` },
    { ...assistant, id: `assistant-${index}`, requestId, content: `Answer ${index}` },
  ];
}).flat();

const nodes = projectAskConversationNodes({
  conversation: askStreamingConversationFixture,
  messages,
  phase: 'idle',
});

describe('AI panel long-conversation diagnostics', () => {
  bench('project a 5,000-message Ask restore into stable keyed nodes', () => {
    const restored = projectAskConversationNodes({
      conversation: askStreamingConversationFixture,
      messages,
      phase: 'idle',
    });
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
