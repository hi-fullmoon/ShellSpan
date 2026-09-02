import type { Terminal } from '@xterm/xterm';

const DRAG_THRESHOLD_PX = 4;

interface SelectionGesture {
  x: number;
  y: number;
  dragging: boolean;
}

function releaseXtermDrag(ownerDocument: Document, event: MouseEvent): void {
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
    altKey: event.altKey,
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
 * Once the pointer crosses the threshold, xterm owns the gesture without any
 * further interference. This preserves fast drags, modifier selections, and
 * word/line extension after double or triple click.
 */
export function installTerminalSelectionGuard(terminal: Terminal): () => void {
  const element = terminal.element;
  if (!element) return () => {};

  const ownerDocument = element.ownerDocument;
  let gesture: SelectionGesture | null = null;

  const handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    gesture = {
      x: event.clientX,
      y: event.clientY,
      dragging: false,
    };
  };

  const handleMouseMove = (event: MouseEvent): void => {
    if (!gesture) return;

    // A buttonless move proves that WKWebView dropped mouseup. Recreate the
    // release synchronously so xterm removes its drag listeners before it can
    // consume this move. A synthetic mouseup also preserves xterm's native
    // normal, word, line, and column selection modes.
    if (!(event.buttons & 1)) {
      gesture = null;
      releaseXtermDrag(ownerDocument, event);
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
      // This listener is installed before xterm adds its document listener on
      // mousedown, so stopping later listeners here creates the dead zone.
      event.stopImmediatePropagation();
    }
  };

  const handleMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) gesture = null;
  };

  element.addEventListener('mousedown', handleMouseDown);
  ownerDocument.addEventListener('mousemove', handleMouseMove);
  ownerDocument.addEventListener('mouseup', handleMouseUp);

  return () => {
    gesture = null;
    element.removeEventListener('mousedown', handleMouseDown);
    ownerDocument.removeEventListener('mousemove', handleMouseMove);
    ownerDocument.removeEventListener('mouseup', handleMouseUp);
  };
}
