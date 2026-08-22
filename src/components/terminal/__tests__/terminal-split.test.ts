import { describe, expect, it } from 'vitest';
import {
  ensureUniqueTerminalGroupIds,
  findAdjacentTerminalGroup,
  findTerminalGroup,
  getTerminalGroups,
  getTerminalSplitDirection,
  partitionSessionIdsPinnedFirst,
  repartitionTerminalLayoutPinnedFirst,
  replaceTerminalSessionId,
  updateTerminalSplitAtPath,
  type TerminalGroupState,
  type TerminalLayoutNode,
} from '../terminal-split';

const rect = {
  left: 100,
  right: 500,
  top: 50,
  bottom: 350,
  width: 400,
  height: 300,
};

describe('getTerminalSplitDirection', () => {
  it.each([
    [105, 200, 'left'],
    [495, 200, 'right'],
    [300, 55, 'top'],
    [300, 345, 'bottom'],
  ] as const)('detects an edge drop at (%s, %s)', (x, y, direction) => {
    expect(getTerminalSplitDirection(rect, x, y)).toBe(direction);
  });

  it('does not show a split target in the center of the content', () => {
    expect(getTerminalSplitDirection(rect, 300, 200)).toBeNull();
  });

  it('does not show a split target outside the content', () => {
    expect(getTerminalSplitDirection(rect, 300, 40)).toBeNull();
  });

  it('uses the nearest edge when edge zones overlap near a corner', () => {
    expect(getTerminalSplitDirection(rect, 108, 70)).toBe('left');
  });
});

const group = (id: string): TerminalGroupState => ({
  kind: 'group',
  id,
  sessionIds: [id],
  activeSessionId: id,
});

describe('findAdjacentTerminalGroup', () => {
  it('moves left and right in a horizontal split', () => {
    const layout: TerminalLayoutNode = {
      kind: 'split',
      orientation: 'horizontal',
      first: group('a'),
      second: group('b'),
    };
    expect(findAdjacentTerminalGroup(layout, 'a', 'right')?.id).toBe('b');
    expect(findAdjacentTerminalGroup(layout, 'b', 'left')?.id).toBe('a');
    expect(findAdjacentTerminalGroup(layout, 'a', 'left')).toBeNull();
    expect(findAdjacentTerminalGroup(layout, 'b', 'right')).toBeNull();
    expect(findAdjacentTerminalGroup(layout, 'a', 'bottom')).toBeNull();
  });

  it('moves up and down in a vertical split', () => {
    const layout: TerminalLayoutNode = {
      kind: 'split',
      orientation: 'vertical',
      first: group('a'),
      second: group('b'),
    };
    expect(findAdjacentTerminalGroup(layout, 'a', 'bottom')?.id).toBe('b');
    expect(findAdjacentTerminalGroup(layout, 'b', 'top')?.id).toBe('a');
    expect(findAdjacentTerminalGroup(layout, 'a', 'top')).toBeNull();
    expect(findAdjacentTerminalGroup(layout, 'b', 'right')).toBeNull();
  });

  it('resolves the nearest group across nested splits', () => {
    // a | (b / c)
    const layout: TerminalLayoutNode = {
      kind: 'split',
      orientation: 'horizontal',
      first: group('a'),
      second: { kind: 'split', orientation: 'vertical', first: group('b'), second: group('c') },
    };
    expect(findAdjacentTerminalGroup(layout, 'b', 'bottom')?.id).toBe('c');
    expect(findAdjacentTerminalGroup(layout, 'c', 'top')?.id).toBe('b');
    expect(findAdjacentTerminalGroup(layout, 'b', 'left')?.id).toBe('a');
    expect(findAdjacentTerminalGroup(layout, 'c', 'left')?.id).toBe('a');
    expect(findAdjacentTerminalGroup(layout, 'a', 'right')?.id).toBe('b');
    expect(findAdjacentTerminalGroup(layout, 'a', 'bottom')).toBeNull();
    expect(findAdjacentTerminalGroup(layout, 'c', 'bottom')).toBeNull();
  });

  it('prefers the deepest matching split when moving across nested rows', () => {
    // (a | b) / c
    const layout: TerminalLayoutNode = {
      kind: 'split',
      orientation: 'vertical',
      first: { kind: 'split', orientation: 'horizontal', first: group('a'), second: group('b') },
      second: group('c'),
    };
    expect(findAdjacentTerminalGroup(layout, 'a', 'right')?.id).toBe('b');
    expect(findAdjacentTerminalGroup(layout, 'b', 'right')).toBeNull();
    expect(findAdjacentTerminalGroup(layout, 'a', 'bottom')?.id).toBe('c');
    expect(findAdjacentTerminalGroup(layout, 'c', 'top')?.id).toBe('b');
  });

  it('returns null for an unknown group', () => {
    const layout: TerminalLayoutNode = {
      kind: 'split',
      orientation: 'horizontal',
      first: group('a'),
      second: group('b'),
    };
    expect(findAdjacentTerminalGroup(layout, 'missing', 'right')).toBeNull();
  });

  it('uses rendered geometry to stay in the same visual row', () => {
    const layout: TerminalLayoutNode = {
      kind: 'split',
      orientation: 'horizontal',
      first: {
        kind: 'split',
        orientation: 'vertical',
        first: group('a'),
        second: group('b'),
      },
      second: {
        kind: 'split',
        orientation: 'vertical',
        first: group('c'),
        second: group('d'),
      },
    };
    const rects = new Map([
      ['a', { left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100 }],
      ['b', { left: 0, right: 100, top: 100, bottom: 200, width: 100, height: 100 }],
      ['c', { left: 100, right: 200, top: 0, bottom: 100, width: 100, height: 100 }],
      ['d', { left: 100, right: 200, top: 100, bottom: 200, width: 100, height: 100 }],
    ]);

    expect(findAdjacentTerminalGroup(layout, 'a', 'right', (id) => rects.get(id) ?? null)?.id)
      .toBe('c');
    expect(findAdjacentTerminalGroup(layout, 'b', 'right', (id) => rects.get(id) ?? null)?.id)
      .toBe('d');
    expect(findAdjacentTerminalGroup(layout, 'd', 'left', (id) => rects.get(id) ?? null)?.id)
      .toBe('b');
  });
});

describe('terminal layout identity and persistence', () => {
  it('repairs duplicate restored group ids', () => {
    const layout: TerminalLayoutNode = {
      kind: 'split',
      orientation: 'horizontal',
      first: group('group-3'),
      second: group('group-3'),
    };

    const repaired = ensureUniqueTerminalGroupIds(layout);
    expect(getTerminalGroups(repaired).map((item) => item.id)).toEqual(['group-3', 'group-4']);
  });

  it('replaces a reconnected session id in its original group', () => {
    const layout: TerminalLayoutNode = {
      kind: 'split',
      orientation: 'horizontal',
      first: { ...group('left'), sessionIds: ['s1', 's2'], activeSessionId: 's1' },
      second: { ...group('right'), sessionIds: ['s3'], activeSessionId: 's3' },
    };

    const next = replaceTerminalSessionId(layout, 's3', 's3-next');
    expect(findTerminalGroup(next, 'right')).toMatchObject({
      sessionIds: ['s3-next'],
      activeSessionId: 's3-next',
    });
    expect(findTerminalGroup(next, 'left')?.sessionIds).toEqual(['s1', 's2']);
  });

  it('updates only the split at the requested tree path', () => {
    const layout: TerminalLayoutNode = {
      kind: 'split',
      orientation: 'vertical',
      split: 0.4,
      first: {
        kind: 'split',
        orientation: 'horizontal',
        split: 0.5,
        first: group('a'),
        second: group('b'),
      },
      second: group('c'),
    };

    const next = updateTerminalSplitAtPath(layout, ['first'], 0.65);
    expect(next.kind).toBe('split');
    if (next.kind !== 'split') return;
    expect(next.split).toBe(0.4);
    expect(next.first).toMatchObject({ kind: 'split', split: 0.65 });
  });
});

describe('partitionSessionIdsPinnedFirst', () => {
  const isPinned = (id: string): boolean => id === 'b' || id === 'd';

  it('moves pinned ids to the front while preserving relative order', () => {
    expect(partitionSessionIdsPinnedFirst(['a', 'b', 'c', 'd', 'e'], isPinned))
      .toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('returns the same array reference when the order already satisfies the invariant', () => {
    const ids = ['b', 'd', 'a', 'c'];
    expect(partitionSessionIdsPinnedFirst(ids, isPinned)).toBe(ids);
  });

  it('returns the same array reference when nothing or everything is pinned', () => {
    const ids = ['a', 'c'];
    expect(partitionSessionIdsPinnedFirst(ids, () => false)).toBe(ids);
    expect(partitionSessionIdsPinnedFirst(ids, () => true)).toBe(ids);
  });
});

describe('repartitionTerminalLayoutPinnedFirst', () => {
  it('reorders every group in the layout', () => {
    const layout: TerminalLayoutNode = {
      kind: 'split',
      orientation: 'horizontal',
      first: { kind: 'group', id: 'g1', sessionIds: ['a', 'b', 'c'], activeSessionId: 'a' },
      second: { kind: 'group', id: 'g2', sessionIds: ['d', 'e'], activeSessionId: 'd' },
    };

    const next = repartitionTerminalLayoutPinnedFirst(layout, (id) => id === 'c' || id === 'd');

    expect(findTerminalGroup(next, 'g1')?.sessionIds).toEqual(['c', 'a', 'b']);
    expect(findTerminalGroup(next, 'g2')?.sessionIds).toEqual(['d', 'e']);
    expect(findTerminalGroup(next, 'g1')?.activeSessionId).toBe('a');
  });

  it('returns the same reference when every group already satisfies the invariant', () => {
    const layout: TerminalLayoutNode = {
      kind: 'split',
      orientation: 'horizontal',
      first: { kind: 'group', id: 'g1', sessionIds: ['b', 'a'], activeSessionId: 'a' },
      second: { kind: 'group', id: 'g2', sessionIds: ['c'], activeSessionId: 'c' },
    };

    expect(repartitionTerminalLayoutPinnedFirst(layout, (id) => id === 'b')).toBe(layout);
  });
});
