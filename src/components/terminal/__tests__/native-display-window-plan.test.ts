import {expect, it} from 'vitest';
import {nativeDisplayWindowContained} from './native-display-window-plan';
it('rejects the clipped physical client of an oversized high-DPI window', () => {
  const area = {x: 0, y: 0, width: 2240, height: 1350};
  expect(nativeDisplayWindowContained(area, {x: 0, y: 46, width: 2220, height: 1380})).toBe(false);
  expect(nativeDisplayWindowContained(area, {x: 0, y: 45, width: 2240, height: 1305})).toBe(true);
});
it('keeps an already contained window unchanged', () => {
  const area = {x: 0, y: 0, width: 2560, height: 1400}, outer = {x: 40, y: 60, width: 1500, height: 960};
  expect(nativeDisplayWindowContained(area, outer)).toBe(true);
  expect(outer).toEqual({x: 40, y: 60, width: 1500, height: 960});
});
it('handles a secondary monitor with a negative physical origin', () => {
  const area = {x: -1920, y: 40, width: 1920, height: 1040};
  expect(nativeDisplayWindowContained(area, {x: -1920, y: 80, width: 1920, height: 1000})).toBe(true);
  expect(nativeDisplayWindowContained(area, {x: -2000, y: 0, width: 1480, height: 1100})).toBe(false);
});
it('rejects invalid or impossible bounds rather than claiming a visible window', () => {
  expect(nativeDisplayWindowContained({x: 0, y: 0, width: 200, height: 200}, {x: 0, y: 0, width: 0, height: 0})).toBe(false);
  expect(nativeDisplayWindowContained({x: 0, y: 0, width: 200, height: 200}, {x: NaN, y: 0, width: 100, height: 90})).toBe(false);
  expect(nativeDisplayWindowContained({x: 0, y: 0, width: 200, height: 200}, {x: 0, y: 0, width: 200, height: 201})).toBe(false);
});
