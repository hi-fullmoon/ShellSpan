import { describe, expect, it } from 'vitest';
import { getViewportConstrainedPosition } from '../useViewportConstrainedPosition';

describe('getViewportConstrainedPosition', () => {
  it('keeps a menu inside the bottom-right viewport edge', () => {
    expect(
      getViewportConstrainedPosition(790, 590, 224, 420, 800, 600),
    ).toEqual({ left: 568, top: 172 });
  });

  it('keeps the viewport padding at the top-left edge', () => {
    expect(
      getViewportConstrainedPosition(-20, -10, 224, 200, 800, 600),
    ).toEqual({ left: 8, top: 8 });
  });

  it('anchors oversized menu content to the viewport padding', () => {
    expect(
      getViewportConstrainedPosition(200, 200, 784, 584, 800, 600),
    ).toEqual({ left: 8, top: 8 });
  });
});
