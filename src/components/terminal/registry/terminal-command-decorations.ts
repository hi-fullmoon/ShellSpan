import type { IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { agentTerminalLeaseState } from '../agent-terminal-lease-state';

interface CommandRange {
  operationId: string;
  start: IMarker;
  end?: IMarker;
  element?: HTMLDivElement;
}

interface PendingCommand {
  operationId: string;
  range?: CommandRange;
}

const MAX_PENDING_COMMANDS = 256;

/** Presentation only. OSC markers never acknowledge execution or release input. */
export function installTerminalCommandDecorations(terminal: Terminal, sessionId: string): IDisposable {
  const ranges = new Set<CommandRange>();
  const pendingCommands: PendingCommand[] = [];
  let operationId: string | undefined;
  let prompt: IMarker | undefined;
  let promptReady = true;
  let disposed = false;
  let frame: number | undefined;

  const remove = (range: CommandRange) => {
    ranges.delete(range);
    range.element?.remove();
    range.start.dispose();
    range.end?.dispose();
  };
  const startPendingCommand = () => {
    const pending = pendingCommands[0];
    if (!pending || pending.range || !promptReady || terminal.buffer.active.type !== 'normal') return;
    const cursor = terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
    const start = terminal.registerMarker(prompt && !prompt.isDisposed ? prompt.line - cursor : 0);
    if (start) {
      pending.range = { operationId: pending.operationId, start };
      ranges.add(pending.range);
    }
  };
  const render = () => {
    frame = undefined;
    const buffer = terminal.buffer.active;
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return;
    const rowHeight = screen.clientHeight / terminal.rows;
    const lease = agentTerminalLeaseState.get(sessionId);
    for (const range of ranges) {
      if (range.start.isDisposed || range.end?.isDisposed) {
        remove(range);
        continue;
      }
      const typing = lease?.operationId === range.operationId && lease.terminalOwned
        && lease.commandPhase === 'typing';
      const end = range.end?.line ?? buffer.baseY + buffer.cursorY;
      const first = Math.max(0, range.start.line - buffer.viewportY);
      const last = Math.min(terminal.rows - 1, end - buffer.viewportY);
      if (buffer.type !== 'normal' || first > last || !rowHeight || (!range.end && !typing)) {
        range.element?.remove();
        range.element = undefined;
        continue;
      }
      if (!range.element) {
        range.element = document.createElement('div');
        range.element.className = 'terminal-agent-command';
        range.element.setAttribute('aria-hidden', 'true');
        screen.appendChild(range.element);
      }
      range.element.style.setProperty('--terminal-command-color', terminal.options.theme?.foreground ?? 'var(--app-primary)');
      range.element.style.top = `${first * rowHeight}px`;
      range.element.style.height = `${(last - first + 1) * rowHeight}px`;
    }
  };
  const schedule = () => {
    if (!disposed && frame === undefined) frame = requestAnimationFrame(render);
  };
  const syncLease = () => {
    const lease = agentTerminalLeaseState.get(sessionId);
    const next = lease?.terminalOwned && lease.commandDisplay ? lease.operationId : undefined;
    schedule();
    if (next === operationId) return;
    operationId = next;
    // Queue behind already received PTY writes, before the readiness handshake
    // allows the backend to type. Never inspect prompts or command text.
    terminal.write('', () => {
      if (disposed) return;
      // Keep a released candidate until its ordered PTY boundary arrives. The
      // private lifecycle can finish before the final display batch is delivered.
      if (!next) return;
      // Lease events can outrun several PTY display batches. Consume command
      // scopes in stream order; only the next prompt may start a later scope.
      if (pendingCommands.length >= MAX_PENDING_COMMANDS) {
        const expired = pendingCommands.shift();
        if (expired?.range) remove(expired.range);
      }
      pendingCommands.push({ operationId: next });
      startPendingCommand();
      schedule();
    });
  };
  const subscriptions = [
    terminal.parser.registerOscHandler(133, (data) => {
      if (data === 'A' && terminal.buffer.active.type === 'normal') {
        const pending = pendingCommands[0];
        if (pending?.range) {
          remove(pending.range);
          pending.range = undefined;
          // A fresh prompt without C discards cancelled input. The first
          // delayed prompt can still reanchor a scope acquired before display.
          if (prompt && !prompt.isDisposed && pending.operationId !== operationId) {
            pendingCommands.shift();
          }
        }
        prompt?.dispose();
        prompt = terminal.registerMarker(0);
        promptReady = true;
        startPendingCommand();
        schedule();
        return false;
      }
      if (data !== 'C' || !promptReady || terminal.buffer.active.type !== 'normal') return false;
      promptReady = false;
      const pending = pendingCommands.shift();
      if (pending?.range) {
        const end = terminal.registerMarker(terminal.buffer.active.cursorX === 0 ? -1 : 0);
        if (end && !pending.range.start.isDisposed && end.line >= pending.range.start.line) {
          pending.range.end = end;
        } else {
          end?.dispose();
          remove(pending.range);
        }
      }
      schedule();
      return false;
    }),
    terminal.onRender(schedule),
    terminal.onScroll(schedule),
    terminal.onResize(schedule),
    terminal.onWriteParsed(schedule),
    terminal.buffer.onBufferChange(schedule),
  ];
  const unsubscribe = agentTerminalLeaseState.subscribe(syncLease);
  syncLease();
  return {
    dispose() {
      disposed = true;
      unsubscribe();
      if (frame !== undefined) cancelAnimationFrame(frame);
      subscriptions.forEach(subscription => subscription.dispose());
      for (const range of ranges) remove(range);
      pendingCommands.length = 0;
      prompt?.dispose();
    },
  };
}
