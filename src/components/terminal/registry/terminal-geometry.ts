import '@xterm/xterm/css/xterm.css';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export const TERMINAL_CONTAINER_CLASS = 'h-full w-full [&_.xterm-viewport]:opacity-0 [&>.terminal.xterm]:h-full [&>.terminal.xterm]:p-[4px_0_4px_4px]';

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
