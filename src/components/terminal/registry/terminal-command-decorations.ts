import type { IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { agentTerminalLeaseState } from '../agent-terminal-lease-state';
import { installTerminalCommandRedraw } from './terminal-command-redraw';
import { installTerminalCommandSource } from './terminal-command-source';

interface CommandRange {
  operationId: string;
  start: IMarker;
  end?: IMarker;
  element?: HTMLDivElement;
  source?: string;
  submission?: string;
}

interface PendingCommand {
  operationId: string;
  visible: boolean;
  anchored: boolean;
  range?: CommandRange;
  submitted?: boolean;
  source?: string;
  submission?: string;
}

const MAX_PENDING_COMMANDS = 256;

/** Presentation only. OSC markers never acknowledge execution or release input. */
export function installTerminalCommandDecorations(terminal: Terminal, sessionId: string): IDisposable & { rebind(): void } {
  const ranges = new Set<CommandRange>();
  const pendingCommands: PendingCommand[] = [];
  const submittedOperations = new Set<string>();
  let operationId: string | undefined;
  let prompt: IMarker | undefined;
  let promptReady = true;
  let disposed = false;
  let frame: number | undefined;
  const displayScope = () => {
    if (terminal.buffer.active.type !== 'normal') return undefined;
    const pending = pendingCommands[0];
    const lease = agentTerminalLeaseState.get(sessionId);
    if (!pending?.visible || !pending.range || lease?.takeoverRequested || lease?.takeoverFailed) return undefined;
    const typing = lease?.operationId === pending.operationId && lease.terminalOwned && lease.commandPhase === 'typing';
    if (!pending.submitted && !typing) return undefined;
    if (pending.range.start.isDisposed) {
      // Readline's oversized-buffer ED2 redraw disposes xterm markers on
      // erased rows. The same unconsumed command now starts at the viewport.
      const buffer = terminal.buffer.active;
      const start = terminal.registerMarker(buffer.viewportY - buffer.baseY - buffer.cursorY);
      if (!start) return undefined;
      pending.range.start = start;
    }
    return { operationId: pending.operationId, start: pending.range.start.line };
  };
  const redraw = installTerminalCommandRedraw(terminal, sessionId, displayScope);
  const source = installTerminalCommandSource(terminal, () => [...ranges].flatMap(range =>
    range.source && range.submission && !range.start.isDisposed && !range.end?.isDisposed
      ? [{ id: range.operationId, source: range.source, submission: range.submission, first: range.start.line,
        last: range.end?.line ?? terminal.buffer.active.baseY + terminal.buffer.active.cursorY, complete: Boolean(range.end) }]
      : []));

  const remove = (range: CommandRange) => {
    ranges.delete(range);
    range.element?.remove();
    range.start.dispose();
    range.end?.dispose();
    if (!disposed) {
      source.refresh();
      terminal.refresh(0, terminal.rows - 1);
    }
  };
  const startPendingCommand = () => {
    const pending = pendingCommands[0];
    if (!pending || pending.anchored || !promptReady || terminal.buffer.active.type !== 'normal') return;
    pending.anchored = true;
    if (!pending.visible) return;
    const cursor = terminal.buffer.active.baseY + terminal.buffer.active.cursorY;
    const start = terminal.registerMarker(prompt && !prompt.isDisposed ? prompt.line - cursor : 0);
    if (start) {
      pending.range = { operationId: pending.operationId, start, source: pending.source, submission: pending.submission };
      ranges.add(pending.range);
      if (pending.source && pending.submission) {
        source.begin(pending.operationId, start.line);
      }
    }
  };
  const render = () => {
    frame = undefined;
    if (redraw.isHeld()) return;
    const buffer = terminal.buffer.active;
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return;
    const rowHeight = screen.clientHeight / terminal.rows;
    const scope = displayScope();
    for (const range of ranges) {
      if (range.start.isDisposed || range.end?.isDisposed) {
        remove(range);
        continue;
      }
      const typing = scope?.operationId === range.operationId;
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
    const next = lease?.terminalOwned && typeof lease.commandExecution === 'boolean' ? lease.operationId : undefined;
    const visible = lease?.commandExecution === true;
    if (next && lease?.commandPhase === 'running') {
      submittedOperations.add(next);
      const pending = pendingCommands.find(command => command.operationId === next);
      if (pending) pending.submitted = true;
    }
    schedule();
    if (next === operationId) return;
    const released = operationId;
    operationId = next;
    // Queue behind already received PTY writes, before the readiness handshake
    // allows the backend to type. Never inspect prompts or command text.
    terminal.write('', () => {
      if (disposed) return;
      if (released) {
        // Running is published under the submission fence before release. A
        // request aborted before submission has no C (or new prompt) to consume.
        if (!submittedOperations.has(released)) {
          const index = pendingCommands.findIndex(pending => pending.operationId === released);
          if (index >= 0) {
            const [aborted] = pendingCommands.splice(index, 1);
            if (aborted.range) remove(aborted.range);
          }
        }
        submittedOperations.delete(released);
      }
      // Submitted scopes survive release until their ordered PTY boundary.
      if (!next) {
        startPendingCommand();
        schedule();
        return;
      }
      // Lease events can outrun several PTY display batches. Consume command
      // scopes in stream order; only the next prompt may start a later scope.
      if (pendingCommands.length >= MAX_PENDING_COMMANDS) {
        const expired = pendingCommands.shift();
        if (expired?.range) remove(expired.range);
      }
      pendingCommands.push({ operationId: next, visible, anchored: false, submitted: submittedOperations.has(next),
        source: lease?.commandDisplay, submission: lease?.commandSubmission ?? lease?.commandDisplay });
      startPendingCommand();
      schedule();
    });
  };
  const subscriptions = [
    terminal.parser.registerOscHandler(133, (data) => {
      if (data === 'A' && terminal.buffer.active.type === 'normal') {
        const pending = pendingCommands[0];
        if (pending?.anchored) {
          if (pending.range) remove(pending.range);
          pending.range = undefined;
          pending.anchored = false;
          // A fresh prompt without C discards cancelled input. The first
          // delayed prompt can still reanchor a scope acquired before display.
          if (prompt && pending.operationId !== operationId) {
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
      // ED2 and C may share a PTY batch, leaving no onWriteParsed/render
      // callback between marker disposal and this immutable command end.
      displayScope();
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
  const dispose = (preserveHistory: boolean) => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    redraw.dispose();
    source.dispose(preserveHistory);
    if (frame !== undefined) cancelAnimationFrame(frame);
    subscriptions.forEach(subscription => subscription.dispose());
    for (const range of ranges) remove(range);
    pendingCommands.length = 0;
    submittedOperations.clear();
    prompt?.dispose();
  };
  return { dispose: () => dispose(false), rebind: () => dispose(true) };
}
