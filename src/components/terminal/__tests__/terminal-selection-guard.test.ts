import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { installTerminalSelectionGuard } from '../terminal-selection-guard';

function mouseEventAt(
  type: string,
  timeStamp: number,
  init: MouseEventInit,
): MouseEvent {
  const event = new MouseEvent(type, {
    ...init,
    detail: init.detail ?? (type === 'mousedown' || type === 'mouseup' ? 1 : 0),
  });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  return event;
}

function makeTerminal() {
  return {
    element: document.createElement('div'),
    clearSelection: vi.fn(),
    select: vi.fn(),
  } as unknown as Terminal;
}

const disposals: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

describe('installTerminalSelectionGuard', () => {
  it('keeps sub-threshold tap drift away from xterm document listeners', () => {
    const terminal = makeTerminal();
    disposals.push(installTerminalSelectionGuard(terminal));
    const xtermMouseMove = vi.fn();
    document.addEventListener('mousemove', xtermMouseMove);
    disposals.push(() => document.removeEventListener('mousemove', xtermMouseMove));

    terminal.element?.dispatchEvent(
      mouseEventAt('mousedown', 1_000, {
        button: 0,
        buttons: 1,
        clientX: 20,
        clientY: 20,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      mouseEventAt('mousemove', 1_020, {
        buttons: 1,
        clientX: 23,
        clientY: 20,
      }),
    );

    expect(xtermMouseMove).not.toHaveBeenCalled();
    expect(terminal.clearSelection).not.toHaveBeenCalled();
  });

  it('hands the gesture to xterm at the threshold and never takes it back', () => {
    const terminal = makeTerminal();
    disposals.push(installTerminalSelectionGuard(terminal));
    const xtermMouseMove = vi.fn();
    document.addEventListener('mousemove', xtermMouseMove);
    disposals.push(() => document.removeEventListener('mousemove', xtermMouseMove));

    terminal.element?.dispatchEvent(
      mouseEventAt('mousedown', 1_000, {
        button: 0,
        buttons: 1,
        clientX: 20,
        clientY: 20,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      mouseEventAt('mousemove', 1_010, {
        buttons: 1,
        clientX: 24,
        clientY: 20,
      }),
    );
    document.dispatchEvent(
      mouseEventAt('mousemove', 1_020, {
        buttons: 1,
        clientX: 21,
        clientY: 20,
      }),
    );

    expect(xtermMouseMove).toHaveBeenCalledTimes(2);
    expect(terminal.clearSelection).not.toHaveBeenCalled();
    expect(terminal.select).not.toHaveBeenCalled();
  });

  it('does not classify a fast long drag as a tap', () => {
    const terminal = makeTerminal();
    disposals.push(installTerminalSelectionGuard(terminal));
    const xtermMouseMove = vi.fn();
    document.addEventListener('mousemove', xtermMouseMove);
    disposals.push(() => document.removeEventListener('mousemove', xtermMouseMove));

    terminal.element?.dispatchEvent(
      mouseEventAt('mousedown', 1_000, {
        button: 0,
        buttons: 1,
        clientX: 20,
        clientY: 20,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      mouseEventAt('mousemove', 1_010, {
        buttons: 1,
        clientX: 140,
        clientY: 90,
      }),
    );

    expect(xtermMouseMove).toHaveBeenCalledOnce();
  });

  it('completes a released tap when WKWebView omits mouseup', () => {
    const terminal = makeTerminal();
    disposals.push(installTerminalSelectionGuard(terminal));
    const xtermMouseMove = vi.fn();
    const xtermMouseUp = vi.fn((_event: MouseEvent) => {
      document.removeEventListener('mousemove', xtermMouseMove);
    });
    document.addEventListener('mousemove', xtermMouseMove);
    document.addEventListener('mouseup', xtermMouseUp);
    disposals.push(() => document.removeEventListener('mousemove', xtermMouseMove));
    disposals.push(() => document.removeEventListener('mouseup', xtermMouseUp));

    terminal.element?.dispatchEvent(
      mouseEventAt('mousedown', 1_000, {
        button: 0,
        buttons: 1,
        clientX: 20,
        clientY: 20,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      mouseEventAt('mousemove', 1_010, {
        buttons: 1,
        clientX: 22,
        clientY: 20,
      }),
    );
    document.dispatchEvent(
      mouseEventAt('mousemove', 1_200, {
        buttons: 0,
        clientX: 23,
        clientY: 20,
      }),
    );

    expect(xtermMouseMove).not.toHaveBeenCalled();
    expect(xtermMouseUp).toHaveBeenCalledOnce();
    expect(xtermMouseUp.mock.calls[0]?.[0]).toMatchObject({
      button: 0,
      buttons: 0,
      clientX: 23,
      clientY: 20,
    });
    expect(terminal.clearSelection).not.toHaveBeenCalled();
    expect(terminal.select).not.toHaveBeenCalled();
  });

  it('uses a synthetic release to preserve a completed drag after a missing mouseup', () => {
    const terminal = makeTerminal();
    disposals.push(installTerminalSelectionGuard(terminal));
    const xtermMouseMove = vi.fn();
    const xtermMouseUp = vi.fn(() => {
      document.removeEventListener('mousemove', xtermMouseMove);
    });
    document.addEventListener('mousemove', xtermMouseMove);
    document.addEventListener('mouseup', xtermMouseUp);
    disposals.push(() => document.removeEventListener('mousemove', xtermMouseMove));
    disposals.push(() => document.removeEventListener('mouseup', xtermMouseUp));

    terminal.element?.dispatchEvent(
      mouseEventAt('mousedown', 1_000, {
        button: 0,
        buttons: 1,
        clientX: 20,
        clientY: 20,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      mouseEventAt('mousemove', 1_050, {
        buttons: 1,
        clientX: 40,
        clientY: 20,
      }),
    );
    document.dispatchEvent(
      mouseEventAt('mousemove', 1_200, {
        buttons: 0,
        clientX: 42,
        clientY: 20,
      }),
    );

    expect(xtermMouseMove).toHaveBeenCalledOnce();
    expect(xtermMouseUp).toHaveBeenCalledOnce();
    expect(terminal.clearSelection).not.toHaveBeenCalled();
    expect(terminal.select).not.toHaveBeenCalled();
  });

  it.each([
    ['Shift+click', { shiftKey: true }],
    ['Alt+click', { altKey: true }],
  ])('does not rewrite %s selection state', (_label, modifiers) => {
    const terminal = makeTerminal();
    disposals.push(installTerminalSelectionGuard(terminal));
    const xtermMouseUp = vi.fn();
    document.addEventListener('mouseup', xtermMouseUp);
    disposals.push(() => document.removeEventListener('mouseup', xtermMouseUp));

    terminal.element?.dispatchEvent(
      mouseEventAt('mousedown', 1_000, {
        button: 0,
        buttons: 1,
        clientX: 20,
        clientY: 20,
        ...modifiers,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      mouseEventAt('mouseup', 1_020, {
        button: 0,
        buttons: 0,
        clientX: 20,
        clientY: 20,
        ...modifiers,
      }),
    );

    expect(xtermMouseUp).toHaveBeenCalledOnce();
    expect(terminal.clearSelection).not.toHaveBeenCalled();
    expect(terminal.select).not.toHaveBeenCalled();
  });

  it.each([2, 3])('allows detail=%i selection to extend after crossing the threshold', (detail) => {
    const terminal = makeTerminal();
    disposals.push(installTerminalSelectionGuard(terminal));
    const xtermMouseMove = vi.fn();
    document.addEventListener('mousemove', xtermMouseMove);
    disposals.push(() => document.removeEventListener('mousemove', xtermMouseMove));

    terminal.element?.dispatchEvent(
      mouseEventAt('mousedown', 1_000, {
        button: 0,
        buttons: 1,
        clientX: 20,
        clientY: 20,
        detail,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      mouseEventAt('mousemove', 1_020, {
        buttons: 1,
        clientX: 30,
        clientY: 20,
      }),
    );

    expect(xtermMouseMove).toHaveBeenCalledOnce();
    expect(terminal.clearSelection).not.toHaveBeenCalled();
    expect(terminal.select).not.toHaveBeenCalled();
  });

  it('stops intercepting events after disposal', () => {
    const terminal = makeTerminal();
    const dispose = installTerminalSelectionGuard(terminal);
    dispose();
    const downstream = vi.fn();
    document.addEventListener('mousemove', downstream);
    disposals.push(() => document.removeEventListener('mousemove', downstream));

    terminal.element?.dispatchEvent(
      mouseEventAt('mousedown', 1_000, {
        button: 0,
        buttons: 1,
        clientX: 20,
        clientY: 20,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      mouseEventAt('mousemove', 1_010, {
        buttons: 1,
        clientX: 21,
        clientY: 20,
      }),
    );

    expect(downstream).toHaveBeenCalledOnce();
  });
});
