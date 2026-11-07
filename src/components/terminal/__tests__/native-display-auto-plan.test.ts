import {expect, it} from 'vitest';
import {nativeDisplayActivePlan, nativeDisplayAutoPlan, nativeDisplayAutoSizes, nativeDisplayGeometry, nativeDisplayPrompt, nativeDisplayViewportSizes} from './native-display-auto-plan';
const token = '8cc5e5e7-818b-4124-8878-6f61cf95e701';
it('isolates horizontal selection reflow from the existing vertical selection-clear policy', () => {
  const parked = nativeDisplayViewportSizes(true), following = nativeDisplayViewportSizes(false);
  expect(parked.map(size => size.width)).toEqual(['440px', '360px', '100%']);
  expect(parked.every(size => size.height === '320px')).toBe(true);
  expect(following).toEqual([nativeDisplayAutoSizes[1], nativeDisplayAutoSizes[2], nativeDisplayAutoSizes[5]]);
  expect(nativeDisplayAutoSizes[2].height).toBe('580px');
});
it('splits an exact unsubmitted Unicode command without Enter and preserves it on continuation', () => {
  for (let index = 0; index < nativeDisplayAutoSizes.length; index++) {
    const plan = nativeDisplayActivePlan(token, index);
    expect(plan.prefix).toContain('中文_é_👩🏽‍💻');
    expect(plan.prefix).not.toMatch(/[\r\n]/);
    expect(plan.prefix.endsWith("'" )).toBe(false);
    expect(plan.prefix + plan.suffix).toBe(plan.source);
    expect(plan.lines[0]).toContain('中文_é_👩🏽‍💻');
    expect(plan.source).not.toContain(plan.end);
    expect(new TextEncoder().encode(plan.source).length).toBeLessThan(8192);
    expect(plan.lines[4].length).toBeGreaterThan(400 * 3);
  }
  expect(() => nativeDisplayActivePlan('../foreign', 0)).toThrow('Owned bounded');
});
it('compares the default prompt with an observed cwd without changing command text', () => {
  expect(nativeDisplayPrompt('D:/owned path/中文')).toBe('PS D:\\owned path\\中文>');
  expect(nativeDisplayPrompt('D:\\owned path\\中文')).toBe('PS D:\\owned path\\中文>');
  expect(nativeDisplayPrompt(undefined)).toBeNull();
  expect(nativeDisplayPrompt('')).toBeNull();
});

it('creates distinct bounded scenes with real hard lines, Unicode and long output without echo-based success markers', () => {
  const scenes = nativeDisplayAutoSizes.map((_, index) => nativeDisplayAutoPlan(token, index, 43));
  expect(new Set(scenes.map(x => x.end)).size).toBe(6);
  for (const scene of scenes) {
    expect(new TextDecoder().decode(Uint8Array.from(atob(scene.encoded), x => x.charCodeAt(0)))).toBe(scene.payload);
    expect(scene.payload).toContain('中文宽字符_é_👩🏽‍💻');
    expect(scene.lines[3].length).toBeGreaterThan(43 * 3);
    expect(scene.lines.slice(4, 6)).toEqual([scene.lines[0].replace('BEGIN', 'HARD_A'), scene.lines[0].replace('BEGIN', 'HARD_B')]);
    expect(scene.source).not.toContain(scene.end);
    expect(scene.source).not.toContain(scene.geometry);
    expect(new TextEncoder().encode(scene.source).length).toBeLessThan(8192);
  }
});
it('accepts one actual size response and rejects duplicate, zero or missing observations', () => {
  const marker = nativeDisplayAutoPlan(token, 1, 40).geometry;
  expect(nativeDisplayGeometry(marker + '40x18', marker)).toEqual({columns: 40, rows: 18});
  expect(nativeDisplayGeometry(marker + '40x18\n' + marker + '40x18', marker)).toBeNull();
  expect(nativeDisplayGeometry(marker + '0x18', marker)).toBeNull();
  expect(nativeDisplayGeometry('no output', marker)).toBeNull();
});
it('refuses foreign namespaces or unbounded scenes before generating any source', () => {
  for (const args of [['../foreign', 0, 100], [token, -1, 100], [token, 6, 100], [token, 0, 0], [token, 0, 401]] as const) {
    expect(() => nativeDisplayAutoPlan(args[0], args[1], args[2])).toThrow('Owned bounded');
  }
  expect(() => nativeDisplayGeometry('', 'all')).toThrow('Owned display geometry');
});
