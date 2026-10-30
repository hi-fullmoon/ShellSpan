import type { IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { agentTerminalLeaseState } from '../agent-terminal-lease-state';

// xterm 6 has no public synchronous render-transaction API. This bounded
// compatibility boundary uses its existing DEC 2026 render buffering, without
// changing the parser, buffer, PTY stream or input/acknowledgement path.
interface SynchronizedOutputAccess {
  _core?: { coreService?: { decPrivateModes: { synchronizedOutput: boolean } } };
}

const MAX_REDRAW_WAIT_MS = 750;

export function installTerminalCommandRedraw(
  terminal: Terminal,
  sessionId: string,
  commandScope: () => { operationId: string; start: number } | undefined,
): IDisposable & { isHeld(): boolean } {
  const core = (terminal as unknown as SynchronizedOutputAccess)._core?.coreService;
  let snapshot: { operationId: string; anchor: IMarker; lines: string[] } | undefined;
  let held = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const currentOperation = () => {
    return terminal.buffer.active.type === 'normal' ? commandScope()?.operationId : undefined;
  };
  const release = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!held) return;
    held = false;
    if (core) core.decPrivateModes.synchronizedOutput = false;
    terminal.refresh(0, terminal.rows - 1);
  };
  const reset = () => {
    release();
    snapshot?.anchor.dispose();
    snapshot = undefined;
  };
  const remember = () => {
    if (held) return;
    const operationId = currentOperation();
    const start = commandScope()?.start;
    if (!operationId || start === undefined) {
      snapshot?.anchor.dispose();
      snapshot = undefined;
      return;
    }
    const buffer = terminal.buffer.active;
    const first = Math.max(start, buffer.viewportY);
    const last = Math.min(buffer.baseY + buffer.cursorY, buffer.viewportY + terminal.rows - 1);
    const lines = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) =>
      buffer.getLine(first + index)?.translateToString(true) ?? '');
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    snapshot?.anchor.dispose();
    const anchor = lines.length ? terminal.registerMarker(first - buffer.baseY - buffer.cursorY) : undefined;
    snapshot = anchor ? { operationId, anchor, lines } : undefined;
  };
  const subscriptions = [
    terminal.onRender(remember),
    terminal.parser.registerCsiHandler({ final: 'K' }, () => {
      const modes = core?.decPrivateModes;
      const operationId = currentOperation();
      if (modes && !held && !modes.synchronizedOutput && operationId
        && snapshot?.operationId === operationId) {
        // Bash bind-x erases the native input before waiting for its private
        // payload. Hold only presentation until the real redraw restores the
        // previous prefix. The live xterm buffer continues to parse every byte.
        held = true;
        modes.synchronizedOutput = true;
        // Bound this hold only. Once native echo paints again, remember()
        // supplies a fresh snapshot for later redraws in the same operation.
        timer = setTimeout(reset, MAX_REDRAW_WAIT_MS);
      }
      return false;
    }),
    terminal.onWriteParsed(() => {
      if (!held || !snapshot) return;
      if (!core?.decPrivateModes.synchronizedOutput
        || currentOperation() !== snapshot.operationId) {
        reset();
        return;
      }
      const buffer = terminal.buffer.active;
      const { anchor, lines } = snapshot;
      const restoredAt = (start: number, offset: number) => lines.slice(offset).every((line, index) =>
        buffer.getLine(start + index)?.translateToString(true).startsWith(line));
      // Ordinary redraws must restore every painted row at its marker. ED2
      // disposes markers; after that native scrolling may drop leading rows,
      // so the surviving suffix must start at the actual viewport edge.
      const offset = Math.max(0, buffer.viewportY - anchor.line);
      const restored = !anchor.isDisposed ? offset < lines.length && restoredAt(anchor.line + offset, offset)
        : lines.some((_, offset) => restoredAt(buffer.viewportY, offset));
      if (restored) {
        release();
      }
    }),
    // A real lifecycle boundary, cancellation, reflow or application-owned
    // synchronized output must always be able to replace the held picture.
    terminal.parser.registerOscHandler(133, data => {
      if (data === 'A' || data === 'C') reset();
      return false;
    }),
    ...(['h', 'l'] as const).map(final => terminal.parser.registerCsiHandler({ prefix: '?', final }, params => {
      if (params.includes(2026)) reset();
      return false;
    })),
    terminal.onResize(reset),
    terminal.onScroll(() => {
      // Native growth scrolls at the bottom; browsing history is a user view
      // change and must immediately release any held picture.
      if (terminal.buffer.active.viewportY !== terminal.buffer.active.baseY) reset();
    }),
    terminal.buffer.onBufferChange(reset),
  ];
  const unsubscribe = agentTerminalLeaseState.subscribe(() => {
    if (!snapshot) return;
    // Decorations consume lease changes after this listener. Queue behind
    // their scope update, without granting any input or lifecycle authority.
    terminal.write('', () => {
      if (snapshot && currentOperation() !== snapshot.operationId) reset();
    });
  });
  return {
    isHeld: () => held,
    dispose() {
      unsubscribe();
      subscriptions.forEach(subscription => subscription.dispose());
      reset();
    },
  };
}
