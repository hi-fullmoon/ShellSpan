import { describe, expect, it } from 'vitest';

import { clampAiPanelWidth, getAiPanelWidthBounds } from '../ai-panel';

describe('AI panel width contract', () => {
  it.each([
    { requested: 100, container: 1_200, expected: 320 },
    { requested: 400, container: 1_200, expected: 400 },
    { requested: 900, container: 1_200, expected: 720 },
  ])('clamps $requested px to $expected px in a $container px container', ({
    requested,
    container,
    expected,
  }) => {
    expect(clampAiPanelWidth(requested, container)).toBe(expected);
  });

  it('preserves the 480 px main-content floor', () => {
    expect(getAiPanelWidthBounds(1_200)).toEqual({ min: 320, max: 720 });
    expect(getAiPanelWidthBounds(1_000)).toEqual({ min: 320, max: 520 });
    expect(getAiPanelWidthBounds(720)).toEqual({ min: 240, max: 240 });
    expect(clampAiPanelWidth(720, 1_000)).toBe(520);
  });

  it('uses the available viewport below the main-content floor', () => {
    expect(getAiPanelWidthBounds(300)).toEqual({ min: 300, max: 300 });
    expect(clampAiPanelWidth(400, 300)).toBe(300);
  });
});
