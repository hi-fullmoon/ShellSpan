import { act } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Event as TauriEvent } from '@tauri-apps/api/event';
import { findHttpLinksInLine, resolveTerminalTheme, terminalRegistry } from '../registry/terminal-registry';

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
  invokeMarkSessionReady: vi.fn().mockResolvedValue(undefined),
  invokeSetSessionOutputPaused: vi.fn().mockResolvedValue(undefined),
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
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.setProperty('--app-surface', '#ffffff');
    document.documentElement.style.setProperty('--app-text', '#0f172a');
    document.documentElement.style.setProperty('--app-primary', '#0e7490');
    document.documentElement.style.setProperty('--app-terminal-selection', 'rgba(14, 116, 144, 0.28)');
    document.documentElement.style.setProperty('--app-terminal-selection-inactive', 'rgba(14, 116, 144, 0.16)');
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

  it('applies the color scheme background to the xterm owner and viewport', () => {
    const controller = createController('s1');
    controller.attach(document.createElement('div'));

    const terminalElement = controller.terminal.element;
    const viewport = terminalElement?.querySelector<HTMLElement>('.xterm-viewport');
    expect(terminalElement).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(terminalElement).toHaveClass('terminal', 'xterm');
    expect(terminalElement).toHaveStyle({ backgroundColor: '#ffffff' });
    expect(viewport).toHaveStyle({ backgroundColor: '#ffffff' });
    expect(terminalElement).toHaveStyle({ width: '100%', height: '100%' });

    terminalRegistry.updateOptions({
      fontSize: 14,
      fontFamily: 'system',
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      colorScheme: 'oneDark',
      autoReconnect: false,
      lineHeight: 1,
      letterSpacing: 0,
      urlDetection: true,
      bellStyle: 'none',
    });

    expect(terminalElement?.style.backgroundColor).toBe('rgb(40, 44, 52)');
    expect(viewport?.style.backgroundColor).toBe('rgb(40, 44, 52)');
  });

  it.each([
    ['dracula', '#282a36', '#ff5555', '#e5e5df'],
    ['nord', '#2e3440', '#bf616a', '#d8dee9'],
    ['gruvboxDark', '#282828', '#cc241d', '#ebdbb2'],
    ['tokyoNight', '#1a1b26', '#f7768e', '#c0caf5'],
    ['catppuccinMocha', '#1e1e2e', '#f38ba8', '#cdd6f4'],
  ] as const)('resolves the %s theme', (scheme, background, red, foreground) => {
    expect(resolveTerminalTheme(scheme)).toMatchObject({ background, foreground, red });
  });

  it('resolves app CSS variables and refreshes them after an app theme change', () => {
    const controller = createController('s1');
    controller.attach(document.createElement('div'));
    expect(controller.terminal.options.theme).toMatchObject({
      background: '#ffffff',
      foreground: '#0f172a',
      cursor: '#0e7490',
      selectionBackground: 'rgba(14, 116, 144, 0.28)',
      selectionInactiveBackground: 'rgba(14, 116, 144, 0.16)',
    });

    document.documentElement.dataset.theme = 'dark';
    document.documentElement.style.setProperty('--app-surface', '#0f172a');
    document.documentElement.style.setProperty('--app-text', '#f8fafc');
    document.documentElement.style.setProperty('--app-primary', '#22d3ee');
    document.documentElement.style.setProperty('--app-terminal-selection', 'rgba(34, 211, 238, 0.3)');
    document.documentElement.style.setProperty('--app-terminal-selection-inactive', 'rgba(34, 211, 238, 0.18)');
    terminalRegistry.refreshTheme();

    expect(controller.terminal.options.theme).toMatchObject({
      background: '#0f172a',
      foreground: '#f8fafc',
      cursor: '#22d3ee',
      selectionBackground: 'rgba(34, 211, 238, 0.3)',
      selectionInactiveBackground: 'rgba(34, 211, 238, 0.18)',
    });
    expect(controller.terminal.element?.style.backgroundColor).toBe('rgb(15, 23, 42)');
  });

  it('hides the xterm viewport via the container Tailwind descendant class', () => {
    const controller = createController('s1');
    controller.attach(document.createElement('div'));

    const viewport = controller.terminal.element?.querySelector<HTMLElement>('.xterm-viewport');
    expect(viewport).not.toBeNull();
    // Tailwind compiles the descendant variant into `container .xterm-viewport { opacity: 0 }`,
    // so the generating class lives on the container; jsdom has no compiled stylesheet.
    expect(controller.container).toHaveClass('[&_.xterm-viewport]:opacity-0');
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

    // Input within the post-reconnect grace window is dropped so a stray
    // keystroke cannot echo into the middle of the shell's first prompt.
    controller.simulateInput('during-grace');
    expect(invokeWriteSession).not.toHaveBeenCalled();

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    try {
      controller.simulateInput('after');
      expect(invokeWriteSession).toHaveBeenCalledWith('s2', 'after');
    } finally {
      nowSpy.mockRestore();
    }
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

  it('only refits attached terminals when cell geometry changes', () => {
    const controller = createController('s1');
    controller.attach(document.createElement('div'));
    const fit = vi.spyOn(controller.fitAddon, 'fit').mockImplementation(() => {});

    controller.updateOptions({
      fontSize: 14,
      fontFamily: 'system',
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      colorScheme: 'app',
      autoReconnect: true,
      lineHeight: 1,
      letterSpacing: 0,
      urlDetection: true,
      bellStyle: 'sound',
    });
    expect(fit).not.toHaveBeenCalled();

    controller.updateOptions({
      fontSize: 16,
      fontFamily: 'system',
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      colorScheme: 'app',
      autoReconnect: true,
      lineHeight: 1,
      letterSpacing: 0,
      urlDetection: true,
      bellStyle: 'sound',
    });
    expect(fit).toHaveBeenCalledTimes(1);
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

  it('pauses backend output at the parser high watermark and resumes after draining', async () => {
    const { invokeSetSessionOutputPaused, listenToSshData } = await import('@/lib/tauri');
    let dataHandler: ((event: TauriEvent<string>) => void) | undefined;
    vi.mocked(listenToSshData).mockImplementation(async (_sessionId, callback) => {
      dataHandler = callback;
      return () => {};
    });
    const controller = createController('s1');
    await vi.waitFor(() => expect(dataHandler).toBeDefined());

    const parsedCallbacks: Array<() => void> = [];
    vi.spyOn(controller.terminal, 'write').mockImplementation((_data, callback) => {
      if (callback) parsedCallbacks.push(callback);
    });
    dataHandler!({ event: 'ssh-data:s1', id: 1, payload: 'x'.repeat(300 * 1024) });
    dataHandler!({ event: 'ssh-data:s1', id: 2, payload: 'y'.repeat(300 * 1024) });

    await vi.waitFor(() => {
      expect(invokeSetSessionOutputPaused).toHaveBeenCalledWith('s1', true);
    });
    parsedCallbacks[0]();
    expect(invokeSetSessionOutputPaused).not.toHaveBeenCalledWith('s1', false);
    parsedCallbacks[1]();
    await vi.waitFor(() => {
      expect(invokeSetSessionOutputPaused).toHaveBeenCalledWith('s1', false);
    });
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

  it('drops input silently while connecting without a disconnected hint', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const requestReconnect = vi.fn();
    const getStatus = vi.fn().mockReturnValue('connecting');
    const controller = terminalRegistry.create(
      's1',
      vi.fn(),
      vi.fn(),
      getStatus,
      requestReconnect,
    );
    controller.attach(document.createElement('div'));

    controller.simulateInput('a');
    controller.simulateInput('\r');

    expect(invokeWriteSession).not.toHaveBeenCalled();
    expect(requestReconnect).not.toHaveBeenCalled();
    const buffer = controller.terminal.buffer.active;
    const content = Array.from(
      { length: buffer.length },
      (_, index) => buffer.getLine(index)?.translateToString(true) ?? '',
    ).join('\n');
    expect(content).not.toContain('terminal.notice.disconnectedHint');
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

  it('releases the auto-reconnect guard after an attempted reconnect settles', async () => {
    vi.useFakeTimers();
    try {
      const { listenToSshClosed } = await import('@/lib/tauri');
      let closedHandler: ((event: any) => void) | undefined;
      vi.mocked(listenToSshClosed).mockImplementation(async (_sessionId, callback) => {
        closedHandler = callback;
        return () => {};
      });
      terminalRegistry.updateOptions({
        fontSize: 14,
        fontFamily: 'system',
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: 10000,
        colorScheme: 'app',
        autoReconnect: true,
        lineHeight: 1,
        letterSpacing: 0,
        urlDetection: true,
        bellStyle: 'none',
      });
      const requestReconnect = vi.fn().mockResolvedValue(undefined);
      const controller = terminalRegistry.create(
        's1',
        vi.fn(),
        vi.fn(),
        () => 'disconnected',
        requestReconnect,
      );
      controller.attach(document.createElement('div'));

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(closedHandler).toBeDefined();

      closedHandler!({
        payload: {
          sessionId: 's1',
          reasonKind: 'transport_disconnect',
          retryable: true,
        },
      });
      await act(async () => {
        vi.advanceTimersByTime(1500);
        await Promise.resolve();
      });
      expect(requestReconnect).toHaveBeenCalledTimes(1);

      closedHandler!({
        payload: {
          sessionId: 's1',
          reasonKind: 'transport_disconnect',
          retryable: true,
        },
      });
      await act(async () => {
        vi.advanceTimersByTime(1500);
        await Promise.resolve();
      });

      expect(requestReconnect).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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
