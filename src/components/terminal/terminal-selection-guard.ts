import type { IBufferRange, Terminal } from '@xterm/xterm';

const MICRO_DRAG_MAX_DISTANCE_PX = 6;
const MICRO_DRAG_MAX_DURATION_MS = 140;
const SYNTHETIC_TAP_MAX_DURATION_MS = 50;

interface SingleClickGesture {
  kind: 'single';
  x: number;
  y: number;
  startedAt: number;
  maxDistance: number;
}

interface LockedSelectionGesture {
  kind: 'locked';
  selection?: IBufferRange;
}

type SelectionGesture = SingleClickGesture | LockedSelectionGesture;

function cloneRange(range: IBufferRange | undefined): IBufferRange | undefined {
  if (!range) return undefined;
  return {
    start: { ...range.start },
    end: { ...range.end },
  };
}

function restoreSelection(terminal: Terminal, range: IBufferRange | undefined): void {
  if (!range) return;
  const startOffset = range.start.y * terminal.cols + range.start.x;
  const endOffset = range.end.y * terminal.cols + range.end.x;
  const from = Math.min(startOffset, endOffset);
  const to = Math.max(startOffset, endOffset);
  if (to <= from) return;
  terminal.select(from % terminal.cols, Math.floor(from / terminal.cols), to - from);
}

function endXtermDrag(terminal: Terminal): void {
  const selection = cloneRange(terminal.getSelectionPosition());
  if (selection) {
    // setSelection removes xterm's document-level drag listeners while keeping
    // the selection that was completed before the missing mouseup.
    restoreSelection(terminal, selection);
  } else {
    // clearSelection also removes those listeners. Call it even when no text is
    // selected; that is the important part for a released tap with no mouseup.
    terminal.clearSelection();
  }
}

/**
 * Normalizes WKWebView's macOS tap-to-click behavior around xterm selection.
 *
 * A single-click drag remains entirely owned by xterm. Multi-click selections
 * are snapshots: double click locks the selected word and triple click locks
 * the selected line, so a synthetic held-button move cannot extend them.
 */
export function installTerminalSelectionGuard(terminal: Terminal): () => void {
  const element = terminal.element;
  if (!element) return () => {};

  let active = true;
  let gesture: SelectionGesture | null = null;

  const afterCurrentEvent = (callback: () => void): void => {
    queueMicrotask(() => {
      if (active) callback();
    });
  };

  const updateDistance = (event: MouseEvent): void => {
    if (gesture?.kind !== 'single') return;
    gesture.maxDistance = Math.max(
      gesture.maxDistance,
      Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y),
    );
  };

  const finishGesture = (event: MouseEvent): void => {
    updateDistance(event);
    const completed = gesture;
    gesture = null;
    if (!completed) return;

    if (completed.kind === 'locked') {
      afterCurrentEvent(() => restoreSelection(terminal, completed.selection));
      return;
    }

    const duration = Math.max(0, event.timeStamp - completed.startedAt);
    const isSyntheticTap = duration <= SYNTHETIC_TAP_MAX_DURATION_MS;
    const isMicroDrag =
      duration <= MICRO_DRAG_MAX_DURATION_MS
      && completed.maxDistance <= MICRO_DRAG_MAX_DISTANCE_PX;
    if (isSyntheticTap || isMicroDrag) {
      afterCurrentEvent(() => {
        if (terminal.hasSelection()) terminal.clearSelection();
      });
    }
  };

  const handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    const clickCount = Math.max(1, event.detail);
    if (clickCount === 1) {
      gesture = {
        kind: 'single',
        x: event.clientX,
        y: event.clientY,
        startedAt: event.timeStamp,
        maxDistance: 0,
      };
      return;
    }

    gesture = {
      kind: 'locked',
      selection: cloneRange(terminal.getSelectionPosition()),
    };

    // xterm normally handles mousedown on its child screen before this event
    // bubbles to the terminal element. Keep a microtask fallback for renderer
    // or DOM changes that make the selection visible only after propagation.
    if (!gesture.selection) {
      const currentGesture = gesture;
      afterCurrentEvent(() => {
        if (gesture === currentGesture) {
          currentGesture.selection = cloneRange(terminal.getSelectionPosition());
        }
      });
    }
  };

  const handleMouseMove = (event: MouseEvent): void => {
    if (!gesture) return;
    if (gesture.kind === 'locked') {
      const completed = gesture;
      gesture = null;
      // Run after xterm's document listener. terminal.select also ends xterm's
      // active drag, preventing later hover movement from extending the word.
      afterCurrentEvent(() => restoreSelection(terminal, completed.selection));
      return;
    }

    // WKWebView can omit mouseup after macOS tap-to-click. A later move with no
    // left button is definitive proof that the tap ended. Stop xterm's drag
    // synchronously, before its document mousemove listener can extend the
    // selection. Deferring this leaves xterm armed for the following move.
    if (!(event.buttons & 1)) {
      gesture = null;
      endXtermDrag(terminal);
      return;
    }

    updateDistance(event);
  };

  const handleMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    finishGesture(event);
  };

  element.addEventListener('mousedown', handleMouseDown);
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);

  return () => {
    active = false;
    gesture = null;
    element.removeEventListener('mousedown', handleMouseDown);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };
}
