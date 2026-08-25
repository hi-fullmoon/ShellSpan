import { afterEach, describe, expect, it, vi } from 'vitest';
import type { editor } from 'monaco-editor/editor/editor.api';
import { installMonacoSelectionGuard } from '../monaco-selection-guard';

function pointerEventAt(
  type: string,
  timeStamp: number,
  init: MouseEventInit & { pointerId?: number },
): PointerEvent {
  const event = new MouseEvent(type, init) as PointerEvent;
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    timeStamp: { value: timeStamp },
  });
  return event;
}

function mouseEventAt(type: string, timeStamp: number, init: MouseEventInit): MouseEvent {
  const event = new MouseEvent(type, init);
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  return event;
}

function makeEditor() {
  const element = document.createElement('div');
  const viewLines = document.createElement('div');
  const line = document.createElement('span');
  viewLines.className = 'view-lines';
  viewLines.append(line);
  element.append(viewLines);
  const codeEditor = {
    getDomNode: vi.fn().mockReturnValue(element),
    getTargetAtClientPoint: vi.fn().mockReturnValue({
      position: { lineNumber: 9, column: 7 },
    }),
    setSelection: vi.fn(),
  } as unknown as editor.IStandaloneCodeEditor;
  return { codeEditor, element, line };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

const disposals: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

describe('installMonacoSelectionGuard', () => {
  it('collapses an instant synthetic trackpad selection to the tapped cursor', async () => {
    const { codeEditor, element, line } = makeEditor();
    disposals.push(installMonacoSelectionGuard(codeEditor));

    line.dispatchEvent(mouseEventAt('mousedown', 1_000, {
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 20,
      detail: 1,
      bubbles: true,
    }));
    document.dispatchEvent(pointerEventAt('pointermove', 1_010, {
      buttons: 1,
      clientX: 600,
      clientY: 90,
    }));
    document.dispatchEvent(pointerEventAt('pointerup', 1_020, {
      button: 0,
      buttons: 0,
      clientX: 600,
      clientY: 90,
    }));
    await flushMicrotasks();

    expect(codeEditor.setSelection).toHaveBeenCalledWith({
      selectionStartLineNumber: 9,
      selectionStartColumn: 7,
      positionLineNumber: 9,
      positionColumn: 7,
    }, 'trackpad-tap-guard');
    expect(element.querySelector('.view-lines')).toContainElement(line);
  });

  it('preserves a deliberate press-and-drag selection', async () => {
    const { codeEditor, line } = makeEditor();
    disposals.push(installMonacoSelectionGuard(codeEditor));

    line.dispatchEvent(mouseEventAt('mousedown', 1_000, {
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 20,
      detail: 1,
      bubbles: true,
    }));
    document.dispatchEvent(pointerEventAt('pointermove', 1_100, {
      buttons: 1,
      clientX: 80,
      clientY: 90,
    }));
    document.dispatchEvent(pointerEventAt('pointerup', 1_200, {
      button: 0,
      buttons: 0,
      clientX: 80,
      clientY: 90,
    }));
    await flushMicrotasks();

    expect(codeEditor.setSelection).not.toHaveBeenCalled();
  });

  it('ends Monaco pointer selection when WKWebView omits pointerup', () => {
    const { codeEditor, element, line } = makeEditor();
    const pointerUp = vi.fn();
    element.addEventListener('pointerup', pointerUp);
    disposals.push(installMonacoSelectionGuard(codeEditor));

    line.dispatchEvent(mouseEventAt('mousedown', 1_000, {
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 20,
      detail: 1,
      bubbles: true,
    }));
    document.dispatchEvent(pointerEventAt('pointermove', 1_200, {
      buttons: 0,
      clientX: 80,
      clientY: 90,
    }));

    expect(pointerUp).toHaveBeenCalledOnce();
  });

  it('does not interfere with double-click or gutter selection', async () => {
    const { codeEditor, element, line } = makeEditor();
    const gutter = document.createElement('div');
    element.append(gutter);
    disposals.push(installMonacoSelectionGuard(codeEditor));

    for (const target of [line, gutter]) {
      target.dispatchEvent(mouseEventAt('mousedown', 1_000, {
        button: 0,
        buttons: 1,
        clientX: 20,
        clientY: 20,
        detail: target === line ? 2 : 1,
        bubbles: true,
      }));
      document.dispatchEvent(pointerEventAt('pointerup', 1_020, {
        button: 0,
        buttons: 0,
        clientX: 20,
        clientY: 20,
      }));
    }
    await flushMicrotasks();

    expect(codeEditor.setSelection).not.toHaveBeenCalled();
  });

  it('cancels queued selection restoration when disposed', async () => {
    const { codeEditor, line } = makeEditor();
    const dispose = installMonacoSelectionGuard(codeEditor);

    line.dispatchEvent(mouseEventAt('mousedown', 1_000, {
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 20,
      detail: 1,
      bubbles: true,
    }));
    document.dispatchEvent(pointerEventAt('pointerup', 1_020, {
      button: 0,
      buttons: 0,
      clientX: 20,
      clientY: 20,
    }));
    dispose();
    await flushMicrotasks();

    expect(codeEditor.setSelection).not.toHaveBeenCalled();
  });
});
