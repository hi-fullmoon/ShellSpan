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
  /** Fraction of the available space assigned to the first child. */
  split?: number;
}

export type TerminalLayoutPath = readonly ('first' | 'second')[];

export type TerminalGroupRect = Pick<
  DOMRect,
  'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'
>;

export function getTerminalGroups(node: TerminalLayoutNode): TerminalGroupState[] {
  if (node.kind === 'group') return [node];
  return [...getTerminalGroups(node.first), ...getTerminalGroups(node.second)];
}

/** Repair layouts written by older versions that could persist duplicate ids. */
export function ensureUniqueTerminalGroupIds(node: TerminalLayoutNode): TerminalLayoutNode {
  const reserved = new Set(getTerminalGroups(node).map((group) => group.id));
  const seen = new Set<TerminalGroupSlot>();
  let nextGroupNumber = 3;

  const allocate = (): TerminalGroupSlot => {
    let id = `group-${nextGroupNumber}`;
    while (reserved.has(id)) {
      nextGroupNumber += 1;
      id = `group-${nextGroupNumber}`;
    }
    reserved.add(id);
    seen.add(id);
    nextGroupNumber += 1;
    return id;
  };

  const visit = (current: TerminalLayoutNode): TerminalLayoutNode => {
    if (current.kind === 'group') {
      if (!seen.has(current.id)) {
        seen.add(current.id);
        return current;
      }
      return { ...current, id: allocate() };
    }
    const first = visit(current.first);
    const second = visit(current.second);
    return first === current.first && second === current.second
      ? current
      : { ...current, first, second };
  };

  return visit(node);
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

/**
 * Keep a terminal in its current group when a reconnect replaces the backend
 * session id. The conversation stays the same; only its transport identity
 * changes.
 */
export function replaceTerminalSessionId(
  node: TerminalLayoutNode,
  previousSessionId: string,
  nextSessionId: string,
): TerminalLayoutNode {
  if (previousSessionId === nextSessionId) return node;
  if (node.kind === 'group') {
    if (!node.sessionIds.includes(previousSessionId)) return node;
    const sessionIds = Array.from(new Set(node.sessionIds.map((id) => (
      id === previousSessionId ? nextSessionId : id
    ))));
    return {
      ...node,
      sessionIds,
      activeSessionId: node.activeSessionId === previousSessionId
        ? nextSessionId
        : node.activeSessionId,
    };
  }
  const first = replaceTerminalSessionId(node.first, previousSessionId, nextSessionId);
  const second = replaceTerminalSessionId(node.second, previousSessionId, nextSessionId);
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function updateTerminalSplitAtPath(
  node: TerminalLayoutNode,
  path: TerminalLayoutPath,
  nextSplit: number,
): TerminalLayoutNode {
  if (node.kind === 'group') return node;
  if (path.length === 0) {
    const split = Math.min(0.99, Math.max(0.01, nextSplit));
    return node.split === split ? node : { ...node, split };
  }
  const [branch, ...rest] = path;
  const child = updateTerminalSplitAtPath(node[branch], rest, nextSplit);
  return child === node[branch] ? node : { ...node, [branch]: child };
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
  getRect?: (groupId: TerminalGroupSlot) => TerminalGroupRect | null,
): TerminalGroupState | null {
  if (node.kind === 'group') return null;

  if (getRect) {
    const sourceRect = getRect(groupId);
    if (sourceRect) {
      const sourceCenterX = sourceRect.left + sourceRect.width / 2;
      const sourceCenterY = sourceRect.top + sourceRect.height / 2;
      const candidates = getTerminalGroups(node)
        .filter((group) => group.id !== groupId)
        .map((group, index) => ({ group, rect: getRect(group.id), index }))
        .filter((candidate): candidate is {
          group: TerminalGroupState;
          rect: TerminalGroupRect;
          index: number;
        } => candidate.rect !== null)
        .filter(({ rect }) => {
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          switch (direction) {
            case 'left': return centerX < sourceCenterX;
            case 'right': return centerX > sourceCenterX;
            case 'top': return centerY < sourceCenterY;
            case 'bottom': return centerY > sourceCenterY;
          }
        })
        .map(({ group, rect, index }) => {
          const horizontal = direction === 'left' || direction === 'right';
          const crossStart = horizontal ? rect.top : rect.left;
          const crossEnd = horizontal ? rect.bottom : rect.right;
          const sourceCrossStart = horizontal ? sourceRect.top : sourceRect.left;
          const sourceCrossEnd = horizontal ? sourceRect.bottom : sourceRect.right;
          const overlap = Math.max(
            0,
            Math.min(sourceCrossEnd, crossEnd) - Math.max(sourceCrossStart, crossStart),
          );
          const crossCenter = (crossStart + crossEnd) / 2;
          const sourceCrossCenter = (sourceCrossStart + sourceCrossEnd) / 2;
          const primaryGap = direction === 'left'
            ? Math.max(0, sourceRect.left - rect.right)
            : direction === 'right'
              ? Math.max(0, rect.left - sourceRect.right)
              : direction === 'top'
                ? Math.max(0, sourceRect.top - rect.bottom)
                : Math.max(0, rect.top - sourceRect.bottom);
          const primaryCenter = horizontal
            ? rect.left + rect.width / 2
            : rect.top + rect.height / 2;
          const sourcePrimaryCenter = horizontal ? sourceCenterX : sourceCenterY;
          return {
            group,
            index,
            overlapsCrossAxis: overlap > 0,
            primaryGap,
            crossDistance: Math.abs(crossCenter - sourceCrossCenter),
            primaryDistance: Math.abs(primaryCenter - sourcePrimaryCenter),
          };
        });

      candidates.sort((a, b) => (
        Number(b.overlapsCrossAxis) - Number(a.overlapsCrossAxis)
        || a.primaryGap - b.primaryGap
        || a.crossDistance - b.crossDistance
        || a.primaryDistance - b.primaryDistance
        || a.index - b.index
      ));
      if (candidates[0]) return candidates[0].group;
    }
  }

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
