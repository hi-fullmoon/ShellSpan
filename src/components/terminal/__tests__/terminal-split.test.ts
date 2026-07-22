import { describe, expect, it } from 'vitest';
import { getTerminalSplitDirection } from '../terminal-split';

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
