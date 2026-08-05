const ELLIPSIS = '…';

let canvasContext: CanvasRenderingContext2D | null | undefined;

function getCanvasContext(): CanvasRenderingContext2D | null {
  if (canvasContext === undefined) {
    canvasContext =
      typeof document === 'undefined'
        ? null
        : document.createElement('canvas').getContext('2d');
  }
  return canvasContext;
}

/**
 * Measure text width in px using a shared canvas. Returns null when canvas
 * measurement is unavailable (e.g. jsdom), so callers can fall back to
 * plain CSS truncation.
 */
export function measureTextWidth(text: string, font: string): number | null {
  const ctx = getCanvasContext();
  if (!ctx) return null;
  ctx.font = font;
  return ctx.measureText(text).width;
}

/**
 * Truncate text in the middle ("head…tail"), keeping both ends visible like
 * Finder does, so the result fits within maxWidth. Binary-searches the
 * longest fitting split; returns a bare ellipsis when nothing else fits.
 */
export function elideMiddle(
  text: string,
  maxWidth: number,
  measure: (text: string) => number,
): string {
  if (measure(text) <= maxWidth) return text;
  // Split by code point so surrogate pairs (emoji) are never cut in half.
  // Grapheme clusters (ZWJ sequences, combining marks) can still split, but
  // that is rare enough in file names to not warrant Intl.Segmenter here.
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  let best = ELLIPSIS;
  while (lo <= hi) {
    const visible = Math.floor((lo + hi) / 2);
    const headLength = Math.ceil(visible / 2);
    const tailLength = visible - headLength;
    const candidate =
      chars.slice(0, headLength).join('') +
      ELLIPSIS +
      chars.slice(chars.length - tailLength).join('');
    if (measure(candidate) <= maxWidth) {
      best = candidate;
      lo = visible + 1;
    } else {
      hi = visible - 1;
    }
  }
  return best;
}
