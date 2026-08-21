export type TerminalSplitDirection = 'left' | 'right' | 'top' | 'bottom';

export type TerminalGroupSlot = string;

export interface TerminalGroupState {
  kind: 'group';
  id: TerminalGroupSlot;
  sessionIds: string[];
  activeSessionId: string;
}

export type TerminalLayoutNode = TerminalGroupState | TerminalSplitState;

export interface TerminalSplitState {
  kind: 'split';
  first: TerminalLayoutNode;
  second: TerminalLayoutNode;
  orientation: 'horizontal' | 'vertical';
}

export function getTerminalGroups(node: TerminalLayoutNode): TerminalGroupState[] {
  if (node.kind === 'group') return [node];
  return [...getTerminalGroups(node.first), ...getTerminalGroups(node.second)];
}

export function findTerminalGroup(
  node: TerminalLayoutNode,
  groupId: TerminalGroupSlot,
): TerminalGroupState | null {
  if (node.kind === 'group') return node.id === groupId ? node : null;
  return findTerminalGroup(node.first, groupId) ?? findTerminalGroup(node.second, groupId);
}

export function updateTerminalGroup(
  node: TerminalLayoutNode,
  groupId: TerminalGroupSlot,
  update: (group: TerminalGroupState) => TerminalGroupState,
): TerminalLayoutNode {
  if (node.kind === 'group') return node.id === groupId ? update(node) : node;
  return {
    ...node,
    first: updateTerminalGroup(node.first, groupId, update),
    second: updateTerminalGroup(node.second, groupId, update),
  };
}

export function replaceTerminalGroup(
  node: TerminalLayoutNode,
  groupId: TerminalGroupSlot,
  replacement: TerminalLayoutNode,
): TerminalLayoutNode {
  if (node.kind === 'group') return node.id === groupId ? replacement : node;
  return {
    ...node,
    first: replaceTerminalGroup(node.first, groupId, replacement),
    second: replaceTerminalGroup(node.second, groupId, replacement),
  };
}

export function pruneEmptyTerminalGroups(node: TerminalLayoutNode): TerminalLayoutNode | null {
  if (node.kind === 'group') return node.sessionIds.length > 0 ? node : null;
  const first = pruneEmptyTerminalGroups(node.first);
  const second = pruneEmptyTerminalGroups(node.second);
  if (!first) return second;
  if (!second) return first;
  // Keep referential equality when nothing was pruned, so callers can bail
  // out of state updates.
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function findAdjacentTerminalGroup(
  node: TerminalLayoutNode,
  groupId: TerminalGroupSlot,
  direction: TerminalSplitDirection,
): TerminalGroupState | null {
  if (node.kind === 'group') return null;

  const inFirst = findTerminalGroup(node.first, groupId) !== null;
  if (!inFirst && findTerminalGroup(node.second, groupId) === null) return null;

  // The closest pane wins: resolve inside the subtree holding the focused
  // group before crossing this split.
  const nested = findAdjacentTerminalGroup(inFirst ? node.first : node.second, groupId, direction);
  if (nested) return nested;

  const matchesOrientation =
    (node.orientation === 'horizontal' && (direction === 'left' || direction === 'right'))
    || (node.orientation === 'vertical' && (direction === 'top' || direction === 'bottom'));
  if (!matchesOrientation) return null;

  if (inFirst && (direction === 'right' || direction === 'bottom')) {
    return getTerminalGroups(node.second)[0] ?? null;
  }
  if (!inFirst && (direction === 'left' || direction === 'top')) {
    const candidates = getTerminalGroups(node.first);
    return candidates[candidates.length - 1] ?? null;
  }
  return null;
}

// Pinned tabs always occupy the front of a group. The layout's sessionIds are
// the source of truth for tab order while split, so every mutation path keeps
// this invariant instead of relying on the global sessions array order.
export function partitionSessionIdsPinnedFirst(
  sessionIds: string[],
  isPinned: (sessionId: string) => boolean,
): string[] {
  const pinned = sessionIds.filter(isPinned);
  if (pinned.length === 0 || pinned.length === sessionIds.length) return sessionIds;
  const partitioned = [...pinned, ...sessionIds.filter((id) => !isPinned(id))];
  // Keep referential equality when the order already satisfies the invariant,
  // so callers can bail out of state updates.
  return partitioned.every((id, index) => id === sessionIds[index]) ? sessionIds : partitioned;
}

export function repartitionTerminalLayoutPinnedFirst(
  node: TerminalLayoutNode,
  isPinned: (sessionId: string) => boolean,
): TerminalLayoutNode {
  if (node.kind === 'group') {
    const sessionIds = partitionSessionIdsPinnedFirst(node.sessionIds, isPinned);
    return sessionIds === node.sessionIds ? node : { ...node, sessionIds };
  }
  const first = repartitionTerminalLayoutPinnedFirst(node.first, isPinned);
  const second = repartitionTerminalLayoutPinnedFirst(node.second, isPinned);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

const SPLIT_EDGE_RATIO = 0.25;
const MAX_SPLIT_EDGE_SIZE = 120;

export function getTerminalSplitDirection(
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>,
  x: number,
  y: number,
): TerminalSplitDirection | null {
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;

  const horizontalEdgeSize = Math.min(rect.width * SPLIT_EDGE_RATIO, MAX_SPLIT_EDGE_SIZE);
  const verticalEdgeSize = Math.min(rect.height * SPLIT_EDGE_RATIO, MAX_SPLIT_EDGE_SIZE);
  const candidates: Array<[TerminalSplitDirection, number]> = [];

  if (x - rect.left <= horizontalEdgeSize) candidates.push(['left', x - rect.left]);
  if (rect.right - x <= horizontalEdgeSize) candidates.push(['right', rect.right - x]);
  if (y - rect.top <= verticalEdgeSize) candidates.push(['top', y - rect.top]);
  if (rect.bottom - y <= verticalEdgeSize) candidates.push(['bottom', rect.bottom - y]);

  candidates.sort((a, b) => a[1] - b[1]);
  return candidates[0]?.[0] ?? null;
}
