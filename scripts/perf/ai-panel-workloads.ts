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

// The original workload has 5,000 messages PLUS 2,500 Turn process rows.
// Keep all events and all 20 revisions: do not reduce the workload to fit a stale count.
export function restoreConversation() {
  const restored = projectAgentChatNodes(events);
  if (restored.length !== 7_500) throw new Error(`Expected 7,500 nodes, received ${restored.length}`);
  return restored;
}
const nodes = restoreConversation();
export function reviseNodes() {
  const revisions = nodes.map(aiConversationNodeRevision);
  if (revisions.length !== 7_500) throw new Error('Node revision diagnostic lost rows');
}
export function reprojectStreaming() {
  for (let index = 1; index <= 20; index += 1) {
    const streamed = projectAgentChatNodes([
      ...events.slice(0, -1),
      sessionEvent(events.length - 1, {
        type: 'assistant/chunk', turnId: 'turn-2499', stepId: 'step-2499',
        data: { requestId: 'request-2499', textDelta: `Result 2499${'.'.repeat(index)}` },
      }),
    ]);
    if (streamed.length !== 7_500) throw new Error(`Streaming projection lost rows: ${streamed.length}`);
    const last = streamed[streamed.length - 1];
    if (!last || last.kind !== 'assistantMessage' || last.state !== 'streaming') {
      throw new Error('Streaming projection lost its final assistant state');
    }
  }
}
