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
  let lastVisible: boolean | undefined;
  let layoutDirty = true;
  let cachedLayout: {
    outerWidth: number;
    outerHeight: number;
    left: number;
    top: number;
    innerWidth: number;
    innerHeight: number;
  } | null = null;
  const lastPainted = ['', '', '', ''];
  const invalidateLayout = () => {
    layoutDirty = true;
    schedule();
  };
  const update = () => {
    frame = undefined;
    const active = terminal.buffer.active;
    const visible = active.type === 'alternate' && element.isConnected && element.clientWidth > 0;
    if (visible !== lastVisible) {
      lastVisible = visible;
      for (const edge of edges) edge.style.display = visible ? 'block' : 'none';
      if (visible) layoutDirty = true;
    }
    if (!visible) return;

    if (layoutDirty || !cachedLayout) {
      const outer = element.getBoundingClientRect();
      const inner = screen.getBoundingClientRect();
      if (!inner.width || !inner.height) return;
      cachedLayout = {
        outerWidth: outer.width,
        outerHeight: outer.height,
        left: inner.left - outer.left,
        top: inner.top - outer.top,
        innerWidth: inner.width,
        innerHeight: inner.height,
      };
      layoutDirty = false;
    }

    const { outerWidth, outerHeight, left, top, innerWidth, innerHeight } = cachedLayout;
    const right = left + innerWidth;
    const bottom = top + innerHeight;
    const { cols, rows } = terminal;
    const colors = theme.colors;
    const reusableCell = active.getNullCell();
    const topLine = active.getLine(active.viewportY);
    const bottomLine = active.getLine(active.viewportY + rows - 1);
    const horizontal = [
      Array.from({ length: cols }, (_, x) => background(topLine?.getCell(x, reusableCell), colors)),
      Array.from({ length: cols }, (_, x) => background(bottomLine?.getCell(x, reusableCell), colors)),
    ];
    const leftEdge = new Array<string>(rows);
    const rightEdge = new Array<string>(rows);
    for (let y = 0; y < rows; y++) {
      const line = active.getLine(active.viewportY + y);
      leftEdge[y] = background(line?.getCell(0, reusableCell), colors);
      rightEdge[y] = background(line?.getCell(cols - 1, reusableCell), colors);
    }
    const vertical = [leftEdge, rightEdge];
    const paint = (index: number, x: number, y: number, width: number, height: number, fill: string) => {
      const w = Math.max(0, width);
      const h = Math.max(0, height);
      const key = `${x}|${y}|${w}|${h}|${fill}`;
      if (lastPainted[index] === key) return;
      lastPainted[index] = key;
      Object.assign(edges[index].style, {
        left: `${x}px`, top: `${y}px`, width: `${w}px`,
        height: `${h}px`, background: fill,
      });
    };
    // Side strips cover corners as well, extending their first/last color.
    paint(0, left, 0, innerWidth, top, gradient(horizontal[0], innerWidth, 'right'));
    paint(1, left, bottom, innerWidth, outerHeight - bottom, gradient(horizontal[1], innerWidth, 'right'));
    for (let side = 0; side < 2; side++) {
      paint(side + 2, side ? right : 0, 0, side ? outerWidth - right : left, outerHeight,
        gradient(vertical[side], innerHeight, 'bottom', top));
    }
  };
  const schedule = () => {
    if (terminal.buffer.active.type !== 'alternate' && !lastVisible) return;
    if (frame === undefined) frame = requestAnimationFrame(update);
  };
  const subscriptions = [
    terminal.onRender(schedule),
    terminal.onResize(invalidateLayout),
    terminal.buffer.onBufferChange(schedule),
    theme.onChangeColors(schedule),
  ];
  const observer = new ResizeObserver(invalidateLayout);
  observer.observe(element);
  observer.observe(screen);
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
