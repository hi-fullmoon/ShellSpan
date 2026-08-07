export interface TrendPathOptions {
  min?: number;
  max?: number;
}

export interface TrendPath {
  line: string;
  area: string;
}

/** Resolves the y-axis range for a trend, guarding against empty/flat series. */
export function computeTrendRange(
  data: number[],
  opts: TrendPathOptions = {},
): { min: number; max: number } {
  if (data.length === 0) {
    return { min: opts.min ?? 0, max: opts.max ?? 1 };
  }
  const min = opts.min ?? 0;
  const max = opts.max ?? Math.max(...data, 1);
  return { min, max: max === min ? max + 1 : max };
}

/**
 * Builds SVG path strings for a line chart with an area fill underneath.
 * Coordinates use the given width/height as the viewport; the caller applies
 * `preserveAspectRatio="none"` so the chart stretches to any container width.
 */
export function buildTrendPath(
  data: number[],
  width: number,
  height: number,
  opts: TrendPathOptions = {},
): TrendPath {
  if (data.length === 0) {
    return { line: '', area: '' };
  }
  const { min, max } = computeTrendRange(data, opts);
  const span = max - min || 1;
  const stepX = data.length > 1 ? width / (data.length - 1) : 0;

  const points = data.map((value, index) => {
    const x = index * stepX;
    const clamped = Math.min(max, Math.max(min, value));
    const y = height - ((clamped - min) / span) * height;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  });

  const line = points.join(' ');
  const area = `${line} L${width.toFixed(2)},${height.toFixed(2)} L${(0).toFixed(2)},${height.toFixed(2)} Z`;
  return { line, area };
}
