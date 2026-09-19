import type { AiConversationNode } from '@/lib/ai/conversation-node';

export function latestTurnReachedOutputLimit(nodes: readonly AiConversationNode[]): boolean {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node?.kind === 'turnTail') return node.endReason.startsWith('outputLimit:');
  }
  return false;
}
