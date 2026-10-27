import { describe, expect, it } from 'vitest';
import { createAgentChatProjector, projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { markRecoveredToolReads } from '@/lib/ai/conversation-tool';
import type { AiConversationNode, AiToolNode } from '@/lib/ai/conversation-node';
import type { AgentSessionEvent } from '@/types/agent-session';
import capture from '@/test/fixtures/tool-result-read-recovery.json';

// Captured read failure and retry from the reported session. Host metadata,
// provider IDs and the private result excerpt are omitted; range evidence is intact.
// Selected events are reindexed contiguously; sourceSeq retains their original sequence.
const events = capture as readonly AgentSessionEvent[];
function tools(nodes: readonly AiConversationNode[]): AiToolNode[] {
  return nodes.flatMap<AiConversationNode>(node => node.kind === 'turnProcess' ? node.children : [node])
    .filter((node): node is AiToolNode => node.kind === 'tool');
}

describe('stored-result read recovery', () => {
  it('marks recovery only after the successful result is committed, retaining failure evidence', () => {
    const projector = createAgentChatProjector();
    const before = tools(projector(events.slice(0, 3)))[0];
    expect(before.recoveredByToolKey).toBeUndefined();
    const [failure, success] = tools(projector(events));
    expect(failure.recoveredByToolKey).toBe(success.key);
    expect(failure.state).toBe('failed');
    expect(failure.error).toBe('maxBytes must be between 1 and 2048');
    expect(failure.output).toBe(failure.error);
    expect(before.recoveredByToolKey).toBeUndefined();
    expect(tools(projectAgentChatNodes(events))).toEqual([failure, success]);
  });

  it('does not treat unrelated, concurrent, rejected or unverified reads as recovery', () => {
    const [failure, success] = tools(projectAgentChatNodes(events.slice(0, 2)))
      .concat(tools(projectAgentChatNodes(events.slice(2))));
    const variants: AiToolNode[] = [
      { ...success, sessionId: `${success.sessionId}-other` },
      { ...success, turnId: `${success.turnId}-other` },
      { ...success, name: 'read_file' },
      { ...success, state: 'running' },
      { ...success, state: 'failed' },
      { ...success, state: 'rejected' },
      { ...success, output: null },
      { ...success, input: { ...success.input as object, artifactId: 'other-result' } },
      { ...success, input: { ...success.input as object, offset: 2048 } },
      { ...success, firstSeq: failure.firstSeq - 1 },
      { ...success, firstSeq: failure.firstSeq - 2, lastSeq: failure.firstSeq - 1 },
    ];
    for (const candidate of variants) {
      const result = markRecoveredToolReads([failure, candidate])[0] as AiToolNode;
      expect(result.recoveredByToolKey, JSON.stringify(candidate)).toBeUndefined();
    }
    const rejected = { ...failure, state: 'rejected' as const };
    expect((markRecoveredToolReads([rejected, success])[0] as AiToolNode).recoveredByToolKey).toBeUndefined();
  });
});
