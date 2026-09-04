import type { Terminal } from '@xterm/xterm';

const DRAG_THRESHOLD_PX = 4;

interface SelectionGesture {
  x: number;
  y: number;
  dragging: boolean;
  lastEvent: MouseEvent;
}

function releaseXtermDrag(ownerDocument: Document, event: MouseEvent, cancelled = false): void {
  const MouseEventConstructor = ownerDocument.defaultView?.MouseEvent ?? MouseEvent;
  ownerDocument.dispatchEvent(new MouseEventConstructor('mouseup', {
    button: 0,
    buttons: 0,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    // Cancellation must not invoke xterm's Alt+click cursor movement.
    altKey: !cancelled && event.altKey,
    metaKey: event.metaKey,
    bubbles: true,
    cancelable: true,
  }));
}

/**
 * Adds a small drag dead zone in front of xterm's document-level selection
 * listener. WKWebView can synthesize a tiny held-button move for macOS
 * tap-to-click; xterm otherwise treats any movement as a selection drag.
 *
 * Release signals from either event stream end stale drags. Capture-phase
 * listeners run before xterm even when its document listener was armed first;
 * xterm consumes mousemove with stopImmediatePropagation.
 */
export function installTerminalSelectionGuard(terminal: Terminal): () => void {
  const element = terminal.element;
  if (!element) return () => {};

  const ownerDocument = element.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  let gesture: SelectionGesture | null = null;

  const finishGesture = (event: MouseEvent, cancelled = false): void => {
    if (!gesture) return;
    gesture = null;
    releaseXtermDrag(ownerDocument, event, cancelled);
  };

  const handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    gesture = {
      x: event.clientX,
      y: event.clientY,
      dragging: false,
      lastEvent: event,
    };
  };

  const handleMouseMove = (event: MouseEvent): void => {
    if (!gesture) return;
    gesture.lastEvent = event;

    // A buttonless move proves that WKWebView dropped mouseup. Recreate the
    // release synchronously so xterm removes its drag listeners before it can
    // consume this move. A synthetic mouseup also preserves xterm's native
    // normal, word, line, and column selection modes.
    if (!(event.buttons & 1)) {
      finishGesture(event);
      return;
    }

    if (!gesture.dragging) {
      const distance = Math.hypot(
        event.clientX - gesture.x,
        event.clientY - gesture.y,
      );
      gesture.dragging = distance >= DRAG_THRESHOLD_PX;
    }

    if (!gesture.dragging) {
      // Stop the move before xterm's document listener sees tap drift.
      event.stopImmediatePropagation();
    }
  };

  const handleMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) gesture = null;
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) finishGesture(event);
  };

  const handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button === 0) finishGesture(event);
  };

  const handlePointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse') finishGesture(event, true);
  };

  const handleClick = (event: MouseEvent): void => {
    if (event.button === 0 && event.detail > 0) finishGesture(event);
  };

  const cancelGesture = (): void => {
    if (gesture) finishGesture(gesture.lastEvent, true);
  };

  element.addEventListener('mousedown', handleMouseDown, true);
  ownerDocument.addEventListener('mousemove', handleMouseMove, true);
  ownerDocument.addEventListener('mouseup', handleMouseUp);
  ownerDocument.addEventListener('pointermove', handlePointerMove, true);
  ownerDocument.addEventListener('pointerup', handlePointerUp, true);
  ownerDocument.addEventListener('pointercancel', handlePointerCancel, true);
  ownerDocument.addEventListener('click', handleClick, true);
  ownerWindow?.addEventListener('blur', cancelGesture);

  return () => {
    cancelGesture();
    element.removeEventListener('mousedown', handleMouseDown, true);
    ownerDocument.removeEventListener('mousemove', handleMouseMove, true);
    ownerDocument.removeEventListener('mouseup', handleMouseUp);
    ownerDocument.removeEventListener('pointermove', handlePointerMove, true);
    ownerDocument.removeEventListener('pointerup', handlePointerUp, true);
    ownerDocument.removeEventListener('pointercancel', handlePointerCancel, true);
    ownerDocument.removeEventListener('click', handleClick, true);
    ownerWindow?.removeEventListener('blur', cancelGesture);
  };
}
