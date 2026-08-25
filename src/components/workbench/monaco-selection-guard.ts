import type { editor, ISelection } from 'monaco-editor/editor/editor.api';

const MICRO_DRAG_MAX_DISTANCE_PX = 6;
const MICRO_DRAG_MAX_DURATION_MS = 140;
const SYNTHETIC_TAP_MAX_DURATION_MS = 50;

interface SelectionGesture {
  x: number;
  y: number;
  startedAt: number;
  maxDistance: number;
  cursor: ISelection;
}

function eventTime(event: MouseEvent | PointerEvent): number {
  return event.timeStamp;
}

function collapsedSelection(lineNumber: number, column: number): ISelection {
  return {
    selectionStartLineNumber: lineNumber,
    selectionStartColumn: column,
    positionLineNumber: lineNumber,
    positionColumn: column,
  };
}

function stopMonacoPointerDrag(
  codeEditor: editor.IStandaloneCodeEditor,
  event: MouseEvent | PointerEvent,
): void {
  const editorElement = codeEditor.getDomNode();
  if (!editorElement) return;
  const pointerUp = new MouseEvent('pointerup', {
    button: 0,
    buttons: 0,
    clientX: event.clientX,
    clientY: event.clientY,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(pointerUp, 'pointerId', {
    configurable: true,
    value: 'pointerId' in event ? event.pointerId : 1,
  });
  editorElement.dispatchEvent(pointerUp);
}

/**
 * Normalizes WKWebView's macOS tap-to-click behavior around Monaco selection.
 *
 * WebKit can report a released trackpad tap as a very short drag, or omit its
 * pointerup and leave Monaco's global selection monitor armed. Short synthetic
 * selections collapse back to the tapped cursor; a later buttonless move ends
 * a stale monitor. Deliberate press-and-drag selections remain untouched.
 */
export function installMonacoSelectionGuard(
  codeEditor: editor.IStandaloneCodeEditor,
): () => void {
  const editorElement = codeEditor.getDomNode();
  if (!editorElement) return () => {};

  let active = true;
  let gesture: SelectionGesture | null = null;

  const afterCurrentEvent = (callback: () => void): void => {
    queueMicrotask(() => {
      if (active) callback();
    });
  };

  const updateDistance = (event: MouseEvent | PointerEvent): void => {
    if (!gesture) return;
    gesture.maxDistance = Math.max(
      gesture.maxDistance,
      Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y),
    );
  };

  const finishGesture = (event: MouseEvent | PointerEvent): void => {
    updateDistance(event);
    const completed = gesture;
    gesture = null;
    if (!completed) return;

    const duration = Math.max(0, eventTime(event) - completed.startedAt);
    const isSyntheticTap = duration <= SYNTHETIC_TAP_MAX_DURATION_MS;
    const isMicroDrag =
      duration <= MICRO_DRAG_MAX_DURATION_MS
      && completed.maxDistance <= MICRO_DRAG_MAX_DISTANCE_PX;
    if (isSyntheticTap || isMicroDrag) {
      afterCurrentEvent(() => codeEditor.setSelection(completed.cursor, 'trackpad-tap-guard'));
    }
  };

  const handleMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || event.detail > 1) {
      gesture = null;
      return;
    }

    const viewLines = editorElement.querySelector('.view-lines');
    if (!(event.target instanceof Node) || !viewLines?.contains(event.target)) {
      gesture = null;
      return;
    }

    const position = codeEditor.getTargetAtClientPoint(event.clientX, event.clientY)?.position;
    if (!position) {
      gesture = null;
      return;
    }

    gesture = {
      x: event.clientX,
      y: event.clientY,
      startedAt: eventTime(event),
      maxDistance: 0,
      cursor: collapsedSelection(position.lineNumber, position.column),
    };
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (!gesture) return;
    updateDistance(event);
    if (event.buttons & 1) return;

    // A buttonless move proves that the tap ended even if WKWebView omitted
    // pointerup. Clear our state before dispatching the synthetic release so
    // its bubbling pointerup cannot finish the same gesture twice.
    const completed = gesture;
    gesture = null;
    stopMonacoPointerDrag(codeEditor, event);

    const duration = Math.max(0, eventTime(event) - completed.startedAt);
    if (
      duration <= SYNTHETIC_TAP_MAX_DURATION_MS
      || (duration <= MICRO_DRAG_MAX_DURATION_MS
        && completed.maxDistance <= MICRO_DRAG_MAX_DISTANCE_PX)
    ) {
      afterCurrentEvent(() => codeEditor.setSelection(completed.cursor, 'trackpad-tap-guard'));
    }
  };

  const handlePointerUp = (event: PointerEvent): void => {
    if (event.button === 0) finishGesture(event);
  };

  const handleMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0 || !gesture) return;
    // Some WKWebView paths deliver mouseup without pointerup. Stop Monaco's
    // pointer monitor as well as completing the selection gesture.
    stopMonacoPointerDrag(codeEditor, event);
    finishGesture(event);
  };

  editorElement.addEventListener('mousedown', handleMouseDown);
  document.addEventListener('pointermove', handlePointerMove, true);
  document.addEventListener('pointerup', handlePointerUp);
  document.addEventListener('mouseup', handleMouseUp);

  return () => {
    active = false;
    gesture = null;
    editorElement.removeEventListener('mousedown', handleMouseDown);
    document.removeEventListener('pointermove', handlePointerMove, true);
    document.removeEventListener('pointerup', handlePointerUp);
    document.removeEventListener('mouseup', handleMouseUp);
  };
}
