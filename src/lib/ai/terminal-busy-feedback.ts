import type { AiConversationNode, AiToolNode } from './conversation-node';

/** Only the latest terminal attempt in the current input may explain a busy state. */
export function latestTerminalBusyAttempt(nodes: readonly AiConversationNode[], terminalSessionId: string | null): string | null {
  const inspect = (node: AiToolNode): string | null => node.state === 'failed'
    && /^(?:Error:\s*)?(?:TERMINAL_VISIBLE_COMMAND_BUSY|TERMINAL_BROKER_LEASE_BUSY|TERMINAL_LEASE_BUSY)(?=:|\s|$)/
      .test(node.error ?? '') ? node.key : null;
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (node.kind === 'userMessage') return null;
    if (node.kind === 'tool' && node.target?.sessionId === terminalSessionId) return inspect(node);
    if (node.kind === 'turnProcess') {
      for (let childIndex = node.children.length - 1; childIndex >= 0; childIndex--) {
        const child = node.children[childIndex];
        if (child.kind === 'tool' && child.target?.sessionId === terminalSessionId) return inspect(child);
      }
    }
  }
  return null;
}
