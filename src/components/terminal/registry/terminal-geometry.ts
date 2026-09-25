import '@xterm/xterm/css/xterm.css';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export const TERMINAL_CONTAINER_CLASS = 'h-full w-full [&_.xterm-viewport]:opacity-0 [&>.terminal.xterm]:h-full [&>.terminal.xterm]:p-[4px_0_4px_4px]';

export function createTerminalResizeHandler(
  terminal: Terminal,
  fit: FitAddon,
  container: HTMLElement,
  onResize: (cols: number, rows: number) => void,
) {
  let timer: number | undefined;
  const cancel = () => {
    window.clearTimeout(timer);
    timer = undefined;
  };
  const measure = () => {
    if (container.offsetParent === null) return undefined;
    return fit.proposeDimensions();
  };
  const schedule = () => {
    // A return to the current grid (or a hidden pane) invalidates any older resize.
    cancel();
    const dimensions = measure();
    if (!dimensions || (dimensions.cols === terminal.cols && dimensions.rows === terminal.rows)) return;
    // Coalesce WebGL reflows while dragging to avoid stretching stale glyphs.
    timer = window.setTimeout(() => {
      timer = undefined;
      // Layout may have changed before ResizeObserver delivers its next callback.
      const latest = measure();
      if (!latest || (latest.cols === terminal.cols && latest.rows === terminal.rows)) return;
      try {
        terminal.resize(latest.cols, latest.rows);
      } catch {
        return;
      }
      onResize(terminal.cols, terminal.rows);
    }, 100);
  };
  return { schedule, cancel };
}

export function measureTerminalGeometry(host: HTMLElement, options: ITerminalOptions): { cols: number; rows: number } | undefined {
  if (!host.clientWidth || !host.clientHeight) return undefined;
  const container = document.createElement('div');
  container.className = TERMINAL_CONTAINER_CLASS;
  container.style.visibility = 'hidden';
  const terminal = new Terminal(options);
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  host.appendChild(container);
  try {
    terminal.open(container);
    return fit.proposeDimensions();
  } finally {
    terminal.dispose();
    container.remove();
  }
}
