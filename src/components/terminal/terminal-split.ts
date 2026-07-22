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
  return { ...node, first, second };
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
