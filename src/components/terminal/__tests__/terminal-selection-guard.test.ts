import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IBufferRange, Terminal } from '@xterm/xterm';
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

function makeTerminal(selection?: IBufferRange) {
  return {
    cols: 80,
    element: document.createElement('div'),
    getSelectionPosition: vi.fn().mockReturnValue(selection),
    hasSelection: vi.fn().mockReturnValue(Boolean(selection)),
    clearSelection: vi.fn(),
    select: vi.fn(),
  } as unknown as Terminal;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

const disposals: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

describe('installTerminalSelectionGuard', () => {
  it('clears a synthetic single tap even when WebKit reports coordinate drift', async () => {
    const terminal = makeTerminal();
    vi.mocked(terminal.hasSelection).mockReturnValue(true);
    disposals.push(installTerminalSelectionGuard(terminal));

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
      mouseEventAt('mouseup', 1_020, {
        button: 0,
        buttons: 0,
        clientX: 140,
        clientY: 90,
      }),
    );
    await flushMicrotasks();

    expect(terminal.clearSelection).toHaveBeenCalledOnce();
  });

  it('leaves an intentional single-click drag entirely to xterm', async () => {
    const terminal = makeTerminal();
    vi.mocked(terminal.hasSelection).mockReturnValue(true);
    disposals.push(installTerminalSelectionGuard(terminal));

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
      mouseEventAt('mousemove', 1_090, {
        buttons: 1,
        clientX: 40,
        clientY: 20,
      }),
    );
    document.dispatchEvent(
      mouseEventAt('mouseup', 1_180, {
        button: 0,
        buttons: 0,
        clientX: 40,
        clientY: 20,
      }),
    );
    await flushMicrotasks();

    expect(terminal.clearSelection).not.toHaveBeenCalled();
    expect(terminal.select).not.toHaveBeenCalled();
  });

  it('ends a released tap synchronously when WKWebView omits mouseup', () => {
    const terminal = makeTerminal();
    disposals.push(installTerminalSelectionGuard(terminal));

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
      mouseEventAt('mousemove', 1_200, {
        buttons: 0,
        clientX: 80,
        clientY: 120,
      }),
    );

    // This must run even without a selection: clearSelection is what removes
    // xterm's stale document-level mousemove and mouseup listeners.
    expect(terminal.clearSelection).toHaveBeenCalledOnce();
    expect(terminal.select).not.toHaveBeenCalled();
  });

  it('preserves a completed drag when recovering from a missing mouseup', () => {
    const selection = { start: { x: 5, y: 2 }, end: { x: 15, y: 3 } };
    const terminal = makeTerminal(selection);
    disposals.push(installTerminalSelectionGuard(terminal));

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
      mouseEventAt('mousemove', 1_200, {
        buttons: 0,
        clientX: 80,
        clientY: 120,
      }),
    );

    expect(terminal.select).toHaveBeenCalledWith(5, 2, 90);
    expect(terminal.clearSelection).not.toHaveBeenCalled();
  });

  it('locks a double-click word when a held-button move follows it', async () => {
    const word = { start: { x: 5, y: 2 }, end: { x: 9, y: 2 } };
    const terminal = makeTerminal(word);
    disposals.push(installTerminalSelectionGuard(terminal));

    terminal.element?.dispatchEvent(
      mouseEventAt('mousedown', 1_000, {
        button: 0,
        buttons: 1,
        clientX: 20,
        clientY: 20,
        detail: 2,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      mouseEventAt('mousemove', 1_010, {
        buttons: 1,
        clientX: 20,
        clientY: 160,
      }),
    );
    await flushMicrotasks();

    expect(terminal.select).toHaveBeenCalledWith(5, 2, 4);
    document.dispatchEvent(
      mouseEventAt('mousemove', 1_020, {
        buttons: 1,
        clientX: 20,
        clientY: 220,
      }),
    );
    await flushMicrotasks();

    expect(terminal.select).toHaveBeenCalledOnce();
    expect(terminal.clearSelection).not.toHaveBeenCalled();
  });

  it('locks a triple-click line, including a range spanning buffer rows', async () => {
    const line = { start: { x: 70, y: 2 }, end: { x: 10, y: 4 } };
    const terminal = makeTerminal(line);
    disposals.push(installTerminalSelectionGuard(terminal));

    terminal.element?.dispatchEvent(
      mouseEventAt('mousedown', 1_000, {
        button: 0,
        buttons: 1,
        clientX: 20,
        clientY: 20,
        detail: 3,
        bubbles: true,
      }),
    );
    document.dispatchEvent(
      mouseEventAt('mouseup', 1_020, {
        button: 0,
        buttons: 0,
        clientX: 20,
        clientY: 80,
        detail: 3,
      }),
    );
    await flushMicrotasks();

    expect(terminal.select).toHaveBeenCalledWith(70, 2, 100);
    expect(terminal.clearSelection).not.toHaveBeenCalled();
  });

  it('captures a multi-click selection that becomes visible after mousedown propagation', async () => {
    const terminal = makeTerminal();
    disposals.push(installTerminalSelectionGuard(terminal));

    terminal.element?.dispatchEvent(
      mouseEventAt('mousedown', 1_000, {
        button: 0,
        buttons: 1,
        clientX: 20,
        clientY: 20,
        detail: 2,
        bubbles: true,
      }),
    );
    vi.mocked(terminal.getSelectionPosition).mockReturnValue({
      start: { x: 12, y: 4 },
      end: { x: 18, y: 4 },
    });
    await flushMicrotasks();

    document.dispatchEvent(
      mouseEventAt('mousemove', 1_020, {
        buttons: 1,
        clientX: 80,
        clientY: 120,
      }),
    );
    await flushMicrotasks();

    expect(terminal.select).toHaveBeenCalledWith(12, 4, 6);
  });

  it('cancels queued selection changes when disposed', async () => {
    const terminal = makeTerminal();
    vi.mocked(terminal.hasSelection).mockReturnValue(true);
    const dispose = installTerminalSelectionGuard(terminal);

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
      mouseEventAt('mouseup', 1_020, {
        button: 0,
        buttons: 0,
        clientX: 20,
        clientY: 20,
      }),
    );
    dispose();
    await flushMicrotasks();

    expect(terminal.clearSelection).not.toHaveBeenCalled();
  });
});
