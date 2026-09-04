import type { AiConversationNode, AiToolNode } from './conversation-node';

type ToolIdentity = Pick<AiToolNode, 'sessionId'> & (
  | Readonly<{ nodeKey: string }>
  | Pick<AiToolNode, 'turnId' | 'stepId' | 'callId'>
);

/** Resolve the same scoped tool for approval metadata and parameter inspection. */
export function findConversationTool(
  nodes: readonly AiConversationNode[],
  identity: ToolIdentity,
): AiToolNode | undefined {
  for (const node of nodes) {
    if (node.kind === 'turnProcess') {
      const tool = findConversationTool(node.children, identity);
      if (tool) return tool;
    } else if (node.kind === 'tool'
      && node.sessionId === identity.sessionId
      && ('nodeKey' in identity
        ? node.key === identity.nodeKey
        : node.turnId === identity.turnId
          && node.stepId === identity.stepId
          && node.callId === identity.callId)) {
      return node;
    }
  }
  return undefined;
}
