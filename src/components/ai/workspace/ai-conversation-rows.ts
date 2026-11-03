import type { AiConversationNode, AiConversationNodeOf } from '@/lib/ai/conversation-node';

export interface AiConversationRow {
  readonly node: AiConversationNode;
  readonly process?: AiConversationNodeOf<'turnProcess'>;
  readonly processMember?: boolean;
  readonly hasResponse?: boolean;
}

/** Keep message keys and parents stable when streamed text becomes tool-bearing progress. */
export function conversationRows(nodes: readonly AiConversationNode[]): AiConversationRow[] {
  const rows: AiConversationRow[] = [];
  let process: AiConversationNodeOf<'turnProcess'> | undefined;
  let controlIndex = -1;
  for (const node of nodes) {
    if (node.kind === 'turnProcess') {
      process = node;
      controlIndex = rows.length;
      rows.push({ node, process });
      for (const child of node.children) rows.push({ node: child, process, processMember: true });
    } else {
      if (process && (process.sessionId !== node.sessionId || process.turnId !== node.turnId
        || node.kind === 'userMessage')) process = undefined;
      if (node.kind === 'assistantMessage' && process) {
        rows[controlIndex] = { ...rows[controlIndex], hasResponse: true };
      }
      rows.push({ node, process: node.kind === 'assistantMessage' ? process : undefined });
    }
  }
  return rows;
}
