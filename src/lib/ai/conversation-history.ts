import type { AiConversationNode } from './conversation-node';
import type { AiScrollAnchor } from './panel-route';

/** Move only a live window; explicitly expanded or detached history stays put. */
export function advancingConversationHistoryIndex(
  nodes: readonly AiConversationNode[],
  firstKey: string | null,
  pageSize: number,
  following: boolean,
): number {
  const current = firstKey === null ? 0 : Math.max(0, nodes.findIndex((node) => node.key === firstKey));
  return following ? Math.max(current, nodes.length - pageSize) : current;
}

/** Include a saved reading position before the scroller restores its geometry. */
export function initialConversationHistoryIndex(
  nodes: readonly AiConversationNode[],
  pageSize: number,
  anchor?: AiScrollAnchor,
): number {
  const start = Math.max(0, nodes.length - pageSize);
  if (!anchor || anchor.atBottom) return start;
  const anchorIndex = nodes.findIndex((node) => node.key === anchor.nodeKey);
  // Unknown keys use the original absolute scrollTop, which needs all rows.
  return anchorIndex < 0 ? 0 : Math.min(start, Math.max(0, anchorIndex - 10));
}
