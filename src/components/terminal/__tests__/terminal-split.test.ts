import { describe, expect, it } from 'vitest';
import {
  findAdjacentTerminalGroup,
  getTerminalSplitDirection,
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
});
