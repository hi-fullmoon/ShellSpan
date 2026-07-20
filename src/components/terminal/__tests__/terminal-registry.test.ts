import { describe, expect, it, beforeEach, vi } from 'vitest';
import { findHttpLinksInLine, terminalRegistry } from '../registry/terminal-registry';

// xterm + addons work in jsdom for write/buffer; fit yields 0x0 (harmless).
// Polyfill ResizeObserver if undefined.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = (globalThis.ResizeObserver ?? RO) as typeof ResizeObserver;

vi.mock('@/lib/tauri', () => ({
  invokeGetSessionStatus: vi.fn().mockResolvedValue({
    sessionId: 's1',
    status: 'connected',
    message: 'ready',
  }),
  invokeWriteSession: vi.fn().mockResolvedValue(undefined),
  invokeResizeSession: vi.fn().mockResolvedValue(undefined),
  listenToSshData: vi.fn().mockResolvedValue(() => {}),
  listenToSshStatus: vi.fn().mockResolvedValue(() => {}),
  listenToSshClosed: vi.fn().mockResolvedValue(() => {}),
}));

function createController(sessionId: string) {
  return terminalRegistry.create(
    sessionId,
    vi.fn(),
    vi.fn(),
    () => 'connected',
    vi.fn(),
  );
}

describe('terminalRegistry', () => {
  beforeEach(() => {
    terminalRegistry.disposeAll();
    terminalRegistry.updateOptions({
      fontSize: 14,
      fontFamily: 'system',
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      colorScheme: 'app',
      autoReconnect: false,
      lineHeight: 1,
      letterSpacing: 0,
      urlDetection: true,
      bellStyle: 'none',
    });
    vi.clearAllMocks();
  });

  it('create attaches container to a host and write appends to buffer', () => {
    const setStatus = vi.fn();
    const setClosed = vi.fn();
    const controller = terminalRegistry.create(
      's1',
      setStatus,
      setClosed,
      () => 'connected',
      vi.fn(),
    );
    const host = document.createElement('div');
    controller.attach(host);
    expect(host.firstChild).toBe(controller.container);
    controller.write('hello');
    expect(controller.terminal.buffer.active.length).toBeGreaterThan(0);
  });

  it('detach keeps buffer intact; reattach to a different host preserves buffer', () => {
    const controller = createController('s1');
    const host1 = document.createElement('div');
    const host2 = document.createElement('div');
    controller.attach(host1);
    controller.write('abc');
    const lenAfterWrite = controller.terminal.buffer.active.length;
    controller.detach();
    expect(host1.firstChild).toBeNull();
    controller.attach(host2);
    expect(host2.firstChild).toBe(controller.container);
    expect(controller.terminal.buffer.active.length).toBe(lenAfterWrite);
  });

  it('rebinds a reconnected session without replacing its terminal or buffer', async () => {
    const { invokeWriteSession, listenToSshData } = await import('@/lib/tauri');
    const controller = createController('s1');
    controller.write('history-before-reconnect\r\n');
    const terminal = controller.terminal;
    const bufferLength = terminal.buffer.active.length;

    terminalRegistry.rebindSession('s1', 's2');

    expect(terminalRegistry.get('s1')).toBeUndefined();
    expect(terminalRegistry.get('s2')).toBe(controller);
    expect(controller.sessionId).toBe('s2');
    expect(controller.terminal).toBe(terminal);
    expect(controller.terminal.buffer.active.length).toBe(bufferLength);
    expect(listenToSshData).toHaveBeenCalledWith('s2', expect.any(Function));

    controller.simulateInput('after');
    expect(invokeWriteSession).toHaveBeenCalledWith('s2', 'after');
  });

  it('dispose removes the controller and container from host', () => {
    const controller = createController('s1');
    const host = document.createElement('div');
    controller.attach(host);
    terminalRegistry.dispose('s1');
    expect(terminalRegistry.get('s1')).toBeUndefined();
    expect(host.firstChild).toBeNull();
  });

  it('detach nulls resizeObserver; reattach creates a fresh observer', () => {
    const controller = createController('s1');
    const host1 = document.createElement('div');
    controller.attach(host1);
    expect(controller.resizeObserver).not.toBeNull();
    const firstObserver = controller.resizeObserver;
    controller.detach();
    expect(controller.resizeObserver).toBeNull();
    const host2 = document.createElement('div');
    controller.attach(host2);
    expect(controller.resizeObserver).not.toBeNull();
    expect(controller.resizeObserver).not.toBe(firstObserver);
  });

  it('attach to a different host without detach replaces the observer', () => {
    const controller = createController('s1');
    const host1 = document.createElement('div');
    controller.attach(host1);
    const firstObserver = controller.resizeObserver;
    const host2 = document.createElement('div');
    controller.attach(host2);
    expect(controller.resizeObserver).not.toBe(firstObserver);
  });

  it('double dispose is a no-op', () => {
    const controller = createController('s1');
    expect(() => {
      controller.dispose();
      controller.dispose();
    }).not.toThrow();
  });

  it('applies display preferences to current and future terminals', () => {
    const existing = createController('s1');
    terminalRegistry.updateOptions({
      fontSize: 16,
      fontFamily: 'consolas',
      cursorBlink: false,
      cursorStyle: 'bar',
      scrollback: 5000,
      lineHeight: 1.2,
      letterSpacing: 1,
      colorScheme: 'oneDark',
      autoReconnect: true,
      urlDetection: false,
      bellStyle: 'sound',
    });

    expect(existing.terminal.options).toMatchObject({
      fontSize: 16,
      fontFamily: 'Consolas, monospace',
      cursorBlink: false,
      cursorStyle: 'bar',
      scrollback: 5000,
      lineHeight: 1.2,
      letterSpacing: 1,
    });

    const future = createController('s2');
    expect(future.terminal.options).toMatchObject({
      fontSize: 16,
      fontFamily: 'Consolas, monospace',
      cursorBlink: false,
      cursorStyle: 'bar',
      scrollback: 5000,
      lineHeight: 1.2,
      letterSpacing: 1,
    });
  });

  it('writes connected input to the session', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const getStatus = vi.fn().mockReturnValue('connected');
    const controller = terminalRegistry.create(
      's1',
      vi.fn(),
      vi.fn(),
      getStatus,
      vi.fn(),
    );
    controller.attach(document.createElement('div'));

    controller.simulateInput('hello');

    expect(invokeWriteSession).toHaveBeenCalledWith('s1', 'hello');
  });

  it('reconciles a connected status emitted before listeners were ready', async () => {
    const setStatus = vi.fn();
    terminalRegistry.create(
      's1',
      setStatus,
      vi.fn(),
      () => 'connecting',
      vi.fn(),
    );

    await vi.waitFor(() => {
      expect(setStatus).toHaveBeenCalledWith('s1', {
        sessionId: 's1',
        status: 'connected',
        message: 'ready',
      });
    });
  });

  it('shows disconnected hint and triggers reconnect on Enter', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const requestReconnect = vi.fn();
    const getStatus = vi.fn().mockReturnValue('disconnected');
    const controller = terminalRegistry.create(
      's1',
      vi.fn(),
      vi.fn(),
      getStatus,
      requestReconnect,
    );
    controller.attach(document.createElement('div'));

    controller.simulateInput('a');
    expect(invokeWriteSession).not.toHaveBeenCalled();
    expect(requestReconnect).not.toHaveBeenCalled();

    controller.simulateInput('\r');
    expect(requestReconnect).toHaveBeenCalledTimes(1);
  });
});

describe('findHttpLinksInLine', () => {
  it('finds HTTP links and trims sentence punctuation', () => {
    expect(findHttpLinksInLine('Open https://example.com/docs, then http://localhost:3000.')).toEqual([
      { text: 'https://example.com/docs', start: 6, end: 29 },
      { text: 'http://localhost:3000', start: 37, end: 57 },
    ]);
  });

  it('ignores non-HTTP schemes', () => {
    expect(findHttpLinksInLine('javascript:alert(1) file:///tmp/test')).toEqual([]);
  });
});
