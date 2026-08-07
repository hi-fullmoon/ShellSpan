import { describe, expect, it } from 'vitest';
import { buildTrendPath, computeTrendRange } from '../trend';

describe('computeTrendRange', () => {
  it('returns an empty-safe range for no data', () => {
    expect(computeTrendRange([])).toEqual({ min: 0, max: 1 });
  });

  it('starts the y-axis at zero by default', () => {
    const range = computeTrendRange([5, 10, 20]);
    expect(range.min).toBe(0);
    expect(range.max).toBe(20);
  });

  it('accepts explicit min/max overrides', () => {
    expect(computeTrendRange([5, 10], { min: 0, max: 100 })).toEqual({ min: 0, max: 100 });
  });

  it('expands an explicit flat range so the line is not invisible', () => {
    const range = computeTrendRange([5, 5], { min: 5, max: 5 });
    expect(range).toEqual({ min: 5, max: 6 });
  });
});

describe('buildTrendPath', () => {
  it('returns empty paths for no data', () => {
    expect(buildTrendPath([], 300, 48)).toEqual({ line: '', area: '' });
  });

  it('maps the first point to the bottom-left when at the minimum', () => {
    const { line } = buildTrendPath([0, 100], 100, 50);
    expect(line.startsWith('M0.00,50.00')).toBe(true);
  });

  it('closes the area path around the bottom of the viewport', () => {
    const { area } = buildTrendPath([0, 50, 100], 300, 48);
    expect(area.endsWith('L300.00,48.00 L0.00,48.00 Z')).toBe(true);
  });

  it('clamps values to the explicit min/max range', () => {
    const { line } = buildTrendPath([200, 5], 100, 50, { min: 0, max: 100 });
    // 200 clamps to 100 → top of the viewport (y = 0).
    expect(line.startsWith('M0.00,0.00')).toBe(true);
    // 5 is 5% up from the bottom of the 0-100 range → y = 47.5.
    expect(line).toContain('L100.00,47.50');
  });

  it('does not divide by zero on a flat series', () => {
    const { line } = buildTrendPath([42, 42, 42], 200, 50);
    expect(line).toContain('L');
    expect(line).not.toContain('NaN');
  });

  it('supports a single data point without step division', () => {
    const { line } = buildTrendPath([10], 100, 50);
    expect(line).toBe('M0.00,0.00');
  });
});
