import type { IBufferCell, IDisposable, Terminal } from '@xterm/xterm';
import { createLogger } from '@/lib/logger';

const logger = createLogger('terminal');
let warnedIncompatibleTheme = false;

interface TerminalColors {
  background: { css: string };
  foreground: { css: string };
  ansi: ReadonlyArray<{ css: string }>;
}

// xterm 6 exposes cell attributes publicly, but not the effective palette (including
// OSC changes). Keep this read-only compatibility boundary here; never parse OSC
// independently or mutate the renderer. package.json pins the tested xterm version.
interface ThemeAccess {
  _core?: {
    _themeService?: {
      colors: TerminalColors;
      onChangeColors: (listener: () => void) => IDisposable;
    };
  };
}

function background(cell: IBufferCell | undefined, colors: TerminalColors): string {
  if (!cell) return colors.background.css;
  const inverse = !!cell.isInverse();
  const value = inverse ? cell.getFgColor() : cell.getBgColor();
  if (inverse ? cell.isFgRGB() : cell.isBgRGB()) {
    return `#${value.toString(16).padStart(6, '0')}`;
  }
  if (inverse ? cell.isFgPalette() : cell.isBgPalette()) {
    return colors.ansi[value]?.css ?? colors.background.css;
  }
  return inverse ? colors.foreground.css : colors.background.css;
}

function gradient(colors: string[], length: number, direction: string, offset = 0): string {
  const stops: string[] = [];
  let start = 0;
  for (let index = 1; index <= colors.length; index++) {
    if (colors[index] === colors[start]) continue;
    stops.push(`${colors[start]} ${start === 0 ? 0 : offset + start * length / colors.length}px ${offset + index * length / colors.length}px`);
    start = index;
  }
  return stops.length === 1 ? colors[0] : `linear-gradient(to ${direction}, ${stops.join(',')})`;
}

/** Extend only the outermost cells into padding, without changing the grid/theme. */
export function installTerminalEdgeBackground(terminal: Terminal): IDisposable {
  const element = terminal.element;
  const screen = element?.querySelector<HTMLElement>('.xterm-screen');
  const theme = (terminal as unknown as ThemeAccess)._core?._themeService;
  if (!element || !screen) return { dispose() {} };
  if (
    !theme || typeof theme.onChangeColors !== 'function' ||
    typeof theme.colors?.background?.css !== 'string' ||
    typeof theme.colors?.foreground?.css !== 'string' ||
    !Array.isArray(theme.colors?.ansi)
  ) {
    if (!warnedIncompatibleTheme) {
      warnedIncompatibleTheme = true;
      logger.warn('xterm theme internals changed; terminal edge background is unavailable');
    }
    return { dispose() {} };
  }

  const edges = ['top', 'bottom', 'left', 'right'].map((side) => {
    const edge = document.createElement('div');
    edge.dataset.terminalEdge = side;
    edge.setAttribute('aria-hidden', 'true');
    Object.assign(edge.style, { position: 'absolute', pointerEvents: 'none', display: 'none' });
    element.appendChild(edge);
    return edge;
  });
  let frame: number | undefined;
  const update = () => {
    frame = undefined;
    const active = terminal.buffer.active;
    const visible = active.type === 'alternate' && element.isConnected && element.clientWidth > 0;
    for (const edge of edges) edge.style.display = visible ? 'block' : 'none';
    if (!visible) return;

    const outer = element.getBoundingClientRect();
    const inner = screen.getBoundingClientRect();
    if (!inner.width || !inner.height) return;
    const left = inner.left - outer.left;
    const top = inner.top - outer.top;
    const right = left + inner.width;
    const bottom = top + inner.height;
    const { cols, rows } = terminal;
    const colors = theme.colors;
    const cellColor = (x: number, y: number) => background(active.getLine(active.viewportY + y)?.getCell(x), colors);
    const horizontal = [0, rows - 1].map((y) => Array.from({ length: cols }, (_, x) => cellColor(x, y)));
    const vertical = [0, cols - 1].map((x) => Array.from({ length: rows }, (_, y) => cellColor(x, y)));
    const paint = (edge: HTMLElement, x: number, y: number, width: number, height: number, fill: string) => {
      Object.assign(edge.style, {
        left: `${x}px`, top: `${y}px`, width: `${Math.max(0, width)}px`,
        height: `${Math.max(0, height)}px`, background: fill,
      });
    };
    // Side strips cover corners as well, extending their first/last color.
    paint(edges[0], left, 0, inner.width, top, gradient(horizontal[0], inner.width, 'right'));
    paint(edges[1], left, bottom, inner.width, outer.height - bottom, gradient(horizontal[1], inner.width, 'right'));
    for (let side = 0; side < 2; side++) {
      paint(edges[side + 2], side ? right : 0, 0, side ? outer.width - right : left, outer.height,
        gradient(vertical[side], inner.height, 'bottom', top));
    }
  };
  const schedule = () => {
    if (frame === undefined) frame = requestAnimationFrame(update);
  };
  const subscriptions = [terminal.onRender(schedule), terminal.buffer.onBufferChange(schedule), theme.onChangeColors(schedule)];
  const observer = new ResizeObserver(schedule);
  observer.observe(element);
  schedule();
  return {
    dispose() {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      for (const subscription of subscriptions) subscription.dispose();
      for (const edge of edges) edge.remove();
    },
  };
}
