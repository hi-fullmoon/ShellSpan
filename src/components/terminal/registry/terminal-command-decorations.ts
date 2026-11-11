import type { IDisposable, IMarker, Terminal } from '@xterm/xterm';
import type { NativeInputDisplayBinding } from '@/lib/terminal/native-input-display';
import { agentTerminalLeaseState } from '../agent-terminal-lease-state';

interface CommandRange {
  operationId: string;
  start: IMarker;
  end?: { marker: IMarker; exclusive: boolean };
  element?: HTMLDivElement;
}

interface PendingCommand {
  operationId: string;
  visible: boolean;
  anchored: boolean;
  range?: CommandRange;
  submitted?: boolean;
}

const MAX_PENDING_COMMANDS = 256;
const NATIVE_CAPTURE_MARKER = /^ShellSpanCapture=[0-9a-f]{64}$/;

/** Presentation only. OSC markers never acknowledge execution or release input. */
export function installTerminalCommandDecorations(
  terminal: Terminal,
  sessionId: string,
  nativeDisplay?: NativeInputDisplayBinding,
): IDisposable & { rebind(): void } {
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
    if (!typing && (nativeDisplay || !pending.submitted)) return undefined;
    if (pending.range.start.isDisposed) return undefined;
    return { operationId: pending.operationId, start: pending.range.start.line };
  };

  const remove = (range: CommandRange) => {
    ranges.delete(range);
    range.element?.remove();
    range.start.dispose();
    range.end?.marker.dispose();
    if (!disposed) {
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
      pending.range = { operationId: pending.operationId, start };
      ranges.add(pending.range);
    }
  };
  const markEnd = (range: CommandRange) => {
    range.end?.marker.dispose();
    const marker = terminal.registerMarker(0);
    // On shell handoff the cursor is usually at the start of the output row.
    // Keep that row's marker so reflow moves the exclusive boundary with it.
    range.end = marker ? { marker, exclusive: terminal.buffer.active.cursorX === 0 } : undefined;
  };
  const finishPendingCommand = (range: CommandRange) => {
    const end = range.end;
    if (!end || range.start.isDisposed || end.marker.line - Number(end.exclusive) < range.start.line) {
      remove(range);
    }
  };
  const render = () => {
    frame = undefined;
    const buffer = terminal.buffer.active;
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return;
    const rowHeight = screen.clientHeight / terminal.rows;
    const scope = displayScope();
    for (const range of ranges) {
      if (range.start.isDisposed || range.end?.marker.isDisposed) {
        remove(range);
        continue;
      }
      const typing = scope?.operationId === range.operationId;
      const end = range.end
        ? range.end.marker.line - Number(range.end.exclusive)
        : buffer.baseY + buffer.cursorY;
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
    const next = lease?.terminalOwned && typeof lease.commandExecution === 'boolean'
      && (!nativeDisplay || lease.commandExecution) ? lease.operationId : undefined;
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
        // Running is published under the submission fence before release. An
        // aborted draft has no command start boundary to consume.
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
        if (!nativeDisplay) startPendingCommand();
        schedule();
        return;
      }
      // Lease events can outrun several PTY display batches. Consume command
      // scopes in stream order; only the next prompt may start a later scope.
      if (pendingCommands.length >= MAX_PENDING_COMMANDS) {
        const expired = pendingCommands.shift();
        if (expired?.range) remove(expired.range);
      }
      pendingCommands.push({ operationId: next, visible, anchored: false, submitted: submittedOperations.has(next) });
      if (!nativeDisplay) startPendingCommand();
      schedule();
    });
  };
  const boundaryHandler = nativeDisplay
    ? terminal.parser.registerOscHandler(nativeDisplay.oscIdentifier, data => {
      if (terminal.buffer.active.type !== 'normal') return false;
      if (data === nativeDisplay.enterPayload) {
        startPendingCommand();
        const range = pendingCommands[0]?.range;
        // Readline can briefly leave display mode to process a resize.
        range?.end?.marker.dispose();
        if (range) range.end = undefined;
      } else if (data === nativeDisplay.exitPayload) {
        const range = pendingCommands[0]?.range;
        if (range && !range.end) markEnd(range);
      } else if (NATIVE_CAPTURE_MARKER.test(data) && pendingCommands[0]?.range) {
        // The first capture boundary after editor handoff is before output.
        // Keep the editor's end marker, even if the cursor has since moved.
        const pending = pendingCommands.shift();
        if (pending?.range) finishPendingCommand(pending.range);
      } else {
        return false;
      }
      schedule();
      return false;
    })
    : terminal.parser.registerOscHandler(133, data => {
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
      promptReady = false;
      const pending = pendingCommands.shift();
      if (pending?.range) {
        markEnd(pending.range);
        finishPendingCommand(pending.range);
      }
      schedule();
      return false;
    });
  const subscriptions = [
    boundaryHandler,
    terminal.onRender(schedule),
    terminal.onScroll(schedule),
    terminal.onResize(schedule),
    terminal.onWriteParsed(schedule),
    terminal.buffer.onBufferChange(schedule),
  ];
  const unsubscribe = agentTerminalLeaseState.subscribe(syncLease);
  syncLease();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    if (frame !== undefined) cancelAnimationFrame(frame);
    subscriptions.forEach(subscription => subscription.dispose());
    for (const range of ranges) remove(range);
    pendingCommands.length = 0;
    submittedOperations.clear();
    prompt?.dispose();
  };
  return { dispose, rebind: dispose };
}
