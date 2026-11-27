import { act } from '@testing-library/react';
import { Terminal, type ILink } from '@xterm/xterm';
import { describe, expect, it, beforeEach, beforeAll, vi } from 'vitest';
import { enableRealCanvas } from '@/tests/real-canvas';
import type { Event as TauriEvent } from '@tauri-apps/api/event';
import type { SessionPtyInfo } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { useTerminalBroadcastStore } from '@/stores/terminalBroadcastStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useToastStore } from '@/stores/toastStore';
import { terminalInputReadiness } from '../terminal-input-readiness';
import { t } from '@/locales';
import {
  appendTerminalOutput,
  getRecentTerminalOutput,
  getRecentTerminalOutputSnapshot,
} from '@/lib/terminal/terminal-output-buffer';
import {
  findHttpLinksInBuffer,
  findHttpLinksInLine,
  resolveTerminalTheme,
  terminalRegistry,
} from '../registry/terminal-registry';
import baseCss from '../../../styles/base.css?raw';

// xterm + addons work in jsdom for write/buffer; fit yields 0x0 (harmless).
// Polyfill ResizeObserver if undefined.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = (globalThis.ResizeObserver ?? RO) as typeof ResizeObserver;

vi.mock('@/lib/ipc/tauri', () => ({
  invokeGetSessionStatus: vi.fn().mockResolvedValue({
    sessionId: 's1',
    status: 'connected',
    message: 'ready',
  }),
  invokeMarkSessionReady: vi.fn().mockResolvedValue(undefined),
  invokeSetSessionOutputPaused: vi.fn().mockResolvedValue(undefined),
  invokeWriteSession: vi.fn().mockResolvedValue(undefined),
  invokeWriteSessionBytes: vi.fn().mockResolvedValue(undefined),
  invokeResizeSession: vi.fn().mockResolvedValue(undefined),
  invokeOpenUrl: vi.fn().mockResolvedValue(undefined),
  invokeRevealPath: vi.fn().mockResolvedValue(undefined),
  listenToSshData: vi.fn().mockResolvedValue(() => {}),
  listenToSshStatus: vi.fn().mockResolvedValue(() => {}),
  listenToSshClosed: vi.fn().mockResolvedValue(() => {}),
  listenToTerminalPromptOrigin: vi.fn().mockResolvedValue(() => {}),
  invokeRespondTerminalPromptOrigin: vi.fn().mockResolvedValue(undefined),
}));

function createController(sessionId: string, ptyInfo?: SessionPtyInfo) {
  return terminalRegistry.create(
    sessionId,
    vi.fn(),
    vi.fn(),
    () => 'connected',
    vi.fn(),
    ptyInfo,
  );
}

describe('terminalRegistry', () => {
  beforeAll(enableRealCanvas);
  beforeEach(() => {
    useTerminalBroadcastStore.getState().configure('off');
    useTerminalStore.setState({sessions: []});
    useToastStore.setState({toasts: []});
    useAppStore.getState().setActiveSection('terminal');
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.setProperty('--app-surface', '#ffffff');
    document.documentElement.style.setProperty('--app-text', '#0f172a');
    document.documentElement.style.setProperty('--app-primary', '#1e293b');
    document.documentElement.style.setProperty('--app-terminal-selection', 'rgba(15, 23, 42, 0.22)');
    document.documentElement.style.setProperty('--app-terminal-selection-inactive', 'rgba(15, 23, 42, 0.12)');
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

  it('keeps startup connection status out of the display and observes filtered session bytes separately', async () => {
    const ipc = await import('@/lib/ipc/tauri');
    const controller = terminalRegistry.create('display-observer', vi.fn(), vi.fn(), () => 'connecting', vi.fn()), visible: {source: string; data: string}[] = [], original: string[] = [];
    const apis = [controller.terminal.write, controller.terminal.writeln, controller.terminal.getSelection];
    const stop = controller.subscribeDisplayOutput(value => visible.push(value));
    const stopRaw = controller.subscribeOutput(value => original.push(value));
    await controller.whenOutputReady();await new Promise<void>(resolve => controller.terminal.write('', resolve));
    expect(visible).toEqual([]);
    expect(original).toEqual([]);
    const removeFilter = controller.subscribeOutputFilter({push: value => value.replace('private-frame', 'visible'), finish: () => 'filter-tail'});
    const calls = vi.mocked(ipc.listenToSshData).mock.calls, onData = calls[calls.length - 1][1];
    onData({event: 'ssh-data:display-observer', id: 1, payload: 'private-frame\t中 é 👩🏽‍💻\r\n'});
    removeFilter();await new Promise<void>(resolve => controller.terminal.write('', resolve));
    expect(original).toEqual(['private-frame\t中 é 👩🏽‍💻\r\n']);
    expect(visible).toEqual([{source: 'session', data: 'visible\t中 é 👩🏽‍💻\r\n'}, {source: 'session', data: 'filter-tail'}]);
    expect([controller.terminal.write, controller.terminal.writeln, controller.terminal.getSelection]).toEqual(apis);
    expect(ipc.invokeWriteSession).not.toHaveBeenCalled();expect(ipc.invokeWriteSessionBytes).not.toHaveBeenCalled();
    stop();stopRaw();controller.dispose();
  });

  it('unsubscribes display observers and drops disposed listeners without changing rendering', async () => {
    const controller = createController('display-observer-lifetime');await controller.whenOutputReady();
    const first = vi.fn(), second = vi.fn(), stop = controller.subscribeDisplayOutput(first);
    controller.subscribeDisplayOutput(second);controller.write('A\t中\r\n');
    expect(first).toHaveBeenCalledExactlyOnceWith({source: 'local', data: 'A\t中\r\n'});
    stop();stop();controller.write('B');expect(first).toHaveBeenCalledTimes(1);expect(second).toHaveBeenCalledTimes(2);
    await new Promise<void>(resolve => controller.terminal.write('', resolve));
    expect(controller.terminal.buffer.active.getLine(controller.terminal.buffer.active.cursorY)?.translateToString(true)).toBe('B');
    controller.dispose();const late = vi.fn();controller.subscribeDisplayOutput(late);controller.write('ignored-after-dispose');expect(second).toHaveBeenCalledTimes(2);expect(late).not.toHaveBeenCalled();
  });

  it('answers only the current generation display request and stops the old listener on rebind', async () => {
    const ipc = await import('@/lib/ipc/tauri');
    const unlisten = vi.fn();
    vi.mocked(ipc.listenToTerminalPromptOrigin).mockClear();
    vi.mocked(ipc.listenToTerminalPromptOrigin).mockResolvedValueOnce(unlisten);
    vi.mocked(ipc.invokeRespondTerminalPromptOrigin).mockClear();
    useTerminalStore.getState().addSession({sessionId: 'origin-ui', title: 'owned', host: 'local', port: 0, username: 'test', terminalSessionId: 'origin-terminal', terminalGeneration: 7});
    const controller = createController('origin-ui', {transportKind: 'windowsConPty', inputMode: 'native-inline', nativeDisplayBinding: {
      protocol: 'shellspan.native-input', inputMode: 'native-inline', oscIdentifier: 1337,
      enterPayload: 'SetUserVar=ShellSpanNativeInput=MQ==', exitPayload: 'SetUserVar=ShellSpanNativeInput=MA==',
      unicodeVersion: '15-graphemes', unicodeScope: 'session', ownedReflowCursorLine: false,
    }});
    await controller.whenOutputReady();
    await new Promise<void>(resolve => controller.terminal.write('PS 👩🏽‍💻> ', resolve));
    const originCalls = vi.mocked(ipc.listenToTerminalPromptOrigin).mock.calls;
    const callback = originCalls[originCalls.length - 1]?.[0];expect(callback).toBeDefined();
    const request = {sessionId: 'origin-ui', terminalSessionId: 'origin-terminal', terminalGeneration: 7, requestId: 'owned-request', requestIndex: 1, timeoutMs: 500,
      geometry: {columns: controller.terminal.cols, rows: controller.terminal.rows, cursorX: controller.terminal.buffer.active.cursorX, cursorY: controller.terminal.buffer.active.cursorY}};
    callback?.({event: 'terminal-prompt-origin-request', id: 1, payload: {...request, terminalGeneration: 6}});
    await act(async () => {await Promise.resolve();});expect(ipc.invokeRespondTerminalPromptOrigin).not.toHaveBeenCalled();
    callback?.({event: 'terminal-prompt-origin-request', id: 1, payload: request});
    callback?.({event: 'terminal-prompt-origin-request', id: 1, payload: request});
    await vi.waitFor(() => expect(ipc.invokeRespondTerminalPromptOrigin).toHaveBeenCalledTimes(1));
    expect(vi.mocked(ipc.invokeRespondTerminalPromptOrigin).mock.calls[0][1].cellWidths).toEqual([1, 1, 1, 2, 1, 1]);
    const waiting = {...request, requestId: 'waiting-request', requestIndex: 2, geometry: {...request.geometry, cursorX: request.geometry.cursorX + 1}};
    callback?.({event: 'terminal-prompt-origin-request', id: 1, payload: waiting});
    terminalRegistry.rebindSession('origin-ui', 'new-origin-ui', {transportKind: 'windowsConPty', inputMode: 'raw'});
    await controller.whenOutputReady();expect(unlisten).toHaveBeenCalledTimes(1);
    callback?.({event: 'terminal-prompt-origin-request', id: 1, payload: request});
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 30));});
    expect(ipc.invokeRespondTerminalPromptOrigin).toHaveBeenCalledTimes(1);
  });

  it('answers the next display request when it arrives before the prior response invocation resolves', async () => {
    const ipc = await import('@/lib/ipc/tauri');
    let releaseResponse: (() => void) | undefined;
    vi.mocked(ipc.invokeRespondTerminalPromptOrigin).mockImplementationOnce(() => new Promise<void>(resolve => {releaseResponse = resolve;}));
    useTerminalStore.getState().addSession({sessionId: 'origin-overlap', title: 'owned', host: 'local', port: 0, username: 'test', terminalSessionId: 'origin-overlap-terminal', terminalGeneration: 7});
    const controller = createController('origin-overlap', {transportKind: 'windowsConPty', inputMode: 'native-inline', nativeDisplayBinding: {
      protocol: 'shellspan.native-input', inputMode: 'native-inline', oscIdentifier: 1337,
      enterPayload: 'SetUserVar=ShellSpanNativeInput=MQ==', exitPayload: 'SetUserVar=ShellSpanNativeInput=MA==',
      unicodeVersion: '15-graphemes', unicodeScope: 'session', ownedReflowCursorLine: false,
    }});
    await controller.whenOutputReady();
    const calls = vi.mocked(ipc.listenToTerminalPromptOrigin).mock.calls;
    const callback = calls[calls.length - 1]?.[0];expect(callback).toBeDefined();
    const request = {sessionId: 'origin-overlap', terminalSessionId: 'origin-overlap-terminal', terminalGeneration: 7,
      requestId: 'first-origin', requestIndex: 1, timeoutMs: 1000,
      geometry: {columns: controller.terminal.cols, rows: controller.terminal.rows,
        cursorX: controller.terminal.buffer.active.cursorX, cursorY: controller.terminal.buffer.active.cursorY}};
    try {
      callback?.({event: 'terminal-prompt-origin-request', id: 1, payload: request});
      await vi.waitFor(() => expect(ipc.invokeRespondTerminalPromptOrigin).toHaveBeenCalledTimes(1));
      callback?.({event: 'terminal-prompt-origin-request', id: 2, payload: {...request, requestId: 'next-origin', requestIndex: 2}});
      callback?.({event: 'terminal-prompt-origin-request', id: 2, payload: {...request, requestId: 'next-origin', requestIndex: 2}});
      callback?.({event: 'terminal-prompt-origin-request', id: 3, payload: {...request, requestId: 'excess-origin', requestIndex: 3}});
      releaseResponse?.();
      await vi.waitFor(() => expect(ipc.invokeRespondTerminalPromptOrigin).toHaveBeenCalledTimes(2));
      expect(vi.mocked(ipc.invokeRespondTerminalPromptOrigin).mock.calls[1][0].requestId).toBe('next-origin');
    } finally {releaseResponse?.();}
  });

  it('does not extend a queued display request deadline while awaiting the previous IPC response', async () => {
    const ipc = await import('@/lib/ipc/tauri');
    let releaseResponse: (() => void) | undefined;
    vi.mocked(ipc.invokeRespondTerminalPromptOrigin).mockImplementationOnce(() => new Promise<void>(resolve => {releaseResponse = resolve;}));
    useTerminalStore.getState().addSession({sessionId: 'origin-expiry', title: 'owned', host: 'local', port: 0, username: 'test', terminalSessionId: 'origin-expiry-terminal', terminalGeneration: 7});
    const controller = createController('origin-expiry', {transportKind: 'windowsConPty', inputMode: 'native-inline', nativeDisplayBinding: {
      protocol: 'shellspan.native-input', inputMode: 'native-inline', oscIdentifier: 1337,
      enterPayload: 'SetUserVar=ShellSpanNativeInput=MQ==', exitPayload: 'SetUserVar=ShellSpanNativeInput=MA==',
      unicodeVersion: '15-graphemes', unicodeScope: 'session', ownedReflowCursorLine: false,
    }});
    await controller.whenOutputReady();
    const calls = vi.mocked(ipc.listenToTerminalPromptOrigin).mock.calls;
    const callback = calls[calls.length - 1]?.[0];expect(callback).toBeDefined();
    const request = {sessionId: 'origin-expiry', terminalSessionId: 'origin-expiry-terminal', terminalGeneration: 7,
      requestId: 'expiry-first', requestIndex: 1, timeoutMs: 1000,
      geometry: {columns: controller.terminal.cols, rows: controller.terminal.rows,
        cursorX: controller.terminal.buffer.active.cursorX, cursorY: controller.terminal.buffer.active.cursorY}};
    const clock = vi.spyOn(Date, 'now');
    try {
      callback?.({event: 'terminal-prompt-origin-request', id: 1, payload: request});
      await vi.waitFor(() => expect(ipc.invokeRespondTerminalPromptOrigin).toHaveBeenCalledTimes(1));
      clock.mockReturnValue(100);
      callback?.({event: 'terminal-prompt-origin-request', id: 2, payload: {...request, requestId: 'expiry-next', requestIndex: 2, timeoutMs: 10}});
      clock.mockReturnValue(200);releaseResponse?.();
      await act(async () => {await new Promise(resolve => setTimeout(resolve, 20));});
      expect(ipc.invokeRespondTerminalPromptOrigin).toHaveBeenCalledTimes(1);
    } finally {clock.mockRestore();releaseResponse?.();}
  });

  it.each([47, 199])('keeps the native prompt cursor at width %i when rejected input produces deduplicated feedback', async columns => {
    const ipc = await import('@/lib/ipc/tauri');
    const controller = createController(`origin-write-feedback-${columns}`, {transportKind: 'windowsConPty', inputMode: 'native-inline'});
    await controller.whenOutputReady();controller.terminal.resize(columns, 30);
    await new Promise<void>(resolve => controller.terminal.write('PS owned> ', resolve));
    const before = {x: controller.terminal.buffer.active.cursorX, y: controller.terminal.buffer.active.cursorY};
    vi.mocked(ipc.invokeWriteSession).mockRejectedValue(new Error('TERMINAL_INPUT_RECOVERY_REQUIRED'));
    try {
      controller.simulateInput('\u001b[1;11R');
      await act(async () => {await new Promise(resolve => setTimeout(resolve, 10));});
      await new Promise<void>(resolve => controller.terminal.write('', resolve));
      expect({x: controller.terminal.buffer.active.cursorX, y: controller.terminal.buffer.active.cursorY}).toEqual(before);
      expect(ipc.invokeWriteSession).toHaveBeenCalledWith(`origin-write-feedback-${columns}`, '\u001b[1;11R');
      controller.simulateInput('x');controller.simulateInput('y');
      await act(async () => {await new Promise(resolve => setTimeout(resolve, 10));});
      expect(useToastStore.getState().toasts).toHaveLength(1);
      expect(useToastStore.getState().toasts[0]).toMatchObject({variant: 'error', message: t('terminal.notice.writeFailedMessage')});
    } finally {vi.mocked(ipc.invokeWriteSession).mockResolvedValue(undefined);}
  });

  it('uses only backend ConPTY metadata and changes it after old output drains', async () => {
    const controller = createController('local', {
      transportKind: 'windowsConPty', windowsBuildNumber: 26300,
    });
    expect(controller.terminal.options.windowsPty).toEqual({ backend: 'conpty', buildNumber: 26300 });
    terminalRegistry.rebindSession('local', 'remote', {
      transportKind: 'sshPty', windowsBuildNumber: 26300,
    });
    expect(controller.terminal.options.windowsPty).toEqual({ backend: 'conpty', buildNumber: 26300 });
    await controller.whenOutputReady();
    expect(controller.terminal.options.windowsPty).toEqual({});
    terminalRegistry.rebindSession('remote', 'unknown-build', { transportKind: 'windowsConPty' });
    await controller.whenOutputReady();
    expect(controller.terminal.options.windowsPty).toEqual({ backend: 'conpty' });
    terminalRegistry.rebindSession('unknown-build', 'legacy');
    await controller.whenOutputReady();
    expect(controller.terminal.options.windowsPty).toEqual({});
    expect(createController('posix', { transportKind: 'localPty' }).terminal.options.windowsPty).toEqual({});
  });

  it('keeps verified ConPTY idle reflow and grapheme measurement until rebind drains', async () => {
    const controller = createController('graphemes', {
      transportKind: 'windowsConPty', inputMode: 'native-inline',
      nativeDisplayBinding: {
        protocol: 'shellspan.native-input', inputMode: 'native-inline', oscIdentifier: 1337,
        enterPayload: 'SetUserVar=ShellSpanNativeInput=MQ==', exitPayload: 'SetUserVar=ShellSpanNativeInput=MA==',
        unicodeVersion: '15-graphemes', unicodeScope: 'session', ownedReflowCursorLine: false,
      },
    });
    await controller.whenOutputReady();
    const term = controller.terminal;
    const write = (text: string) => new Promise<void>(resolve => term.write(text, resolve));
    expect(term.unicode.activeVersion).toBe('15-graphemes');
    expect(term.options.reflowCursorLine).toBe(true);
    await write('\x1b]1337;SetUserVar=ShellSpanNativeInput=MQ==\x07👩🏽‍💻');
    expect(term.unicode.activeVersion).toBe('15-graphemes');
    expect(term.options.reflowCursorLine).toBe(false);
    expect(term.buffer.active.cursorX).toBe(2);
    await write('\x1b]1337;SetUserVar=ShellSpanNativeInput=MA==\x07');
    expect(term.options.reflowCursorLine).toBe(true);
    await write('👩🏽‍💻');
    expect(term.buffer.active.cursorX).toBe(4);
    terminalRegistry.rebindSession('graphemes', 'raw-output', { transportKind: 'windowsConPty', inputMode: 'raw' });
    await controller.whenOutputReady();
    expect(term.unicode.activeVersion).toBe('6');
    expect(term.options.reflowCursorLine).toBe(false);
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe('👩🏽‍💻👩🏽‍💻');
  });

  it('resizes each replacement PTY to the existing renderer before releasing its output', async () => {
    const ipc = await import('@/lib/ipc/tauri');
    const controller = createController('before-rebind', { transportKind: 'windowsConPty' });
    await controller.whenOutputReady();
    controller.terminal.resize(97, 31);
    vi.mocked(ipc.invokeResizeSession).mockClear();
    vi.mocked(ipc.invokeMarkSessionReady).mockClear();
    let acknowledge: (() => void) | undefined;
    vi.mocked(ipc.invokeResizeSession).mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    terminalRegistry.rebindSession('before-rebind', 'after-rebind', { transportKind: 'windowsConPty' });
    await vi.waitFor(() => expect(ipc.invokeResizeSession).toHaveBeenCalledWith('after-rebind', 97, 31));
    expect(ipc.invokeMarkSessionReady).not.toHaveBeenCalled();
    acknowledge!();
    await controller.whenOutputReady();
    expect(ipc.invokeMarkSessionReady).toHaveBeenCalledWith('after-rebind');
    vi.mocked(ipc.invokeResizeSession).mockClear();
    terminalRegistry.rebindSession('after-rebind', 'third-connection', { transportKind: 'windowsConPty' });
    await controller.whenOutputReady();
    expect(ipc.invokeResizeSession).toHaveBeenCalledWith('third-connection', 97, 31);
  });

  it('configures a deferred Windows startup before releasing its output', async () => {
    const ipc = await import('@/lib/ipc/tauri');
    vi.mocked(ipc.invokeResizeSession).mockClear();
    vi.mocked(ipc.invokeMarkSessionReady).mockClear();
    let acknowledge: (() => void) | undefined;
    vi.mocked(ipc.invokeResizeSession).mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    const controller = createController('deferred-console', { transportKind: 'windowsConPty', deferredStartup: true });
    controller.terminal.resize(132, 28);
    await vi.waitFor(() => expect(ipc.invokeResizeSession).toHaveBeenCalledWith('deferred-console', 132, 28));
    expect(ipc.invokeMarkSessionReady).not.toHaveBeenCalled();
    acknowledge!();
    await controller.whenOutputReady();
    expect(ipc.invokeMarkSessionReady).toHaveBeenCalledWith('deferred-console');
  });

  it('ignores a previous connection resize acknowledgement after a second rebind', async () => {
    const ipc = await import('@/lib/ipc/tauri');
    const controller = createController('original');
    await controller.whenOutputReady();
    vi.mocked(ipc.invokeMarkSessionReady).mockClear();
    let acknowledge: (() => void) | undefined;
    vi.mocked(ipc.invokeResizeSession).mockImplementationOnce(() => new Promise<void>(resolve => { acknowledge = resolve; }));
    terminalRegistry.rebindSession('original', 'superseded');
    await vi.waitFor(() => expect(acknowledge).toBeDefined());
    terminalRegistry.rebindSession('superseded', 'current');
    await controller.whenOutputReady();
    acknowledge!();
    await act(async () => { await Promise.resolve(); });
    expect(ipc.invokeMarkSessionReady).toHaveBeenCalledWith('current');
    expect(ipc.invokeMarkSessionReady).not.toHaveBeenCalledWith('superseded');
  });

  it('preserves old normal-screen cells when a new ConPTY starts at cursor home', async () => {
    const ptyInfo: SessionPtyInfo = { transportKind: 'windowsConPty', windowsBuildNumber: 26300 };
    const controller = createController('old-console', ptyInfo);
    await controller.whenOutputReady();
    controller.terminal.resize(40, 6);
    const write = (text: string) => new Promise<void>(resolve => controller.terminal.write(text, resolve));
    await write('OLD_CONNECTION_OUTPUT\r\nold prompt>');
    const selection = controller.terminal.getSelection;
    const reset = vi.spyOn(controller.terminal, 'reset');
    const clear = vi.spyOn(controller.terminal, 'clear');
    terminalRegistry.rebindSession('old-console', 'new-console', ptyInfo);
    await controller.whenOutputReady();
    await write('\u001b[HNEW_CONNECTION_OUTPUT\r\nnew prompt>');
    const buffer = controller.terminal.buffer.normal;
    const text = Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '').join('\n');
    expect(text).toContain('OLD_CONNECTION_OUTPUT');
    expect(text).toContain('NEW_CONNECTION_OUTPUT');
    expect(controller.terminal.getSelection).toBe(selection);
    expect(reset).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
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
    expect(controller.terminal.options.overviewRuler).toEqual({ width: 10 });
    const ruler = controller.terminal.element?.querySelector<HTMLCanvasElement>(
      '.xterm-decoration-overview-ruler',
    );
    expect(ruler).toBeInstanceOf(HTMLCanvasElement);
    // jsdom has no layout height; give the actual ruler a drawable surface.
    ruler!.height = 1;
    const context = ruler!.getContext('2d');
    expect(context).not.toBeNull();
    context!.fillStyle = '#ff0000';
    context!.fillRect(0, 0, 1, 1);
    expect(Array.from(context!.getImageData(0, 0, 1, 1).data)).toEqual([255, 0, 0, 255]);
    expect(controller.terminal.textarea).toBeInstanceOf(HTMLTextAreaElement);
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
    expect(resolveTerminalTheme(scheme)).toMatchObject({ background, foreground, red, overviewRulerBorder: '#00000000' });
  });

  it('resolves app CSS variables and refreshes them after an app theme change', () => {
    const controller = createController('s1');
    controller.attach(document.createElement('div'));
    expect(controller.terminal.options.theme).toMatchObject({
      overviewRulerBorder: '#00000000',
      background: '#ffffff',
      foreground: '#0f172a',
      cursor: '#1e293b',
      selectionBackground: 'rgba(15, 23, 42, 0.22)',
      selectionInactiveBackground: 'rgba(15, 23, 42, 0.12)',
      blue: '#0969da',
      brightYellow: '#9a6700',
      brightGreen: '#1a7f37',
      brightCyan: '#0e7490',
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
    expect(controller.terminal.options.theme?.brightYellow).toBeUndefined();
    expect(controller.terminal.element?.style.backgroundColor).toBe('rgb(15, 23, 42)');
  });

  it('provides a complete 16-color light preset and applies minimumContrastRatio updates', () => {
    expect(resolveTerminalTheme('light')).toMatchObject({
      background: '#ffffff',
      foreground: '#1f2328',
      blue: '#0969da',
      brightBlack: '#57606a',
      brightGreen: '#1a7f37',
      brightYellow: '#9a6700',
      brightBlue: '#1f6feb',
      brightCyan: '#0e7490',
      brightWhite: '#ffffff',
    });

    const controller = createController('s-contrast');
    controller.attach(document.createElement('div'));
    expect(controller.terminal.options.minimumContrastRatio).toBe(4.5);

    terminalRegistry.updateOptions({
      fontSize: 14,
      fontFamily: 'system',
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      colorScheme: 'light',
      minimumContrastRatio: 7,
      autoReconnect: false,
      lineHeight: 1,
      letterSpacing: 0,
      urlDetection: true,
      bellStyle: 'none',
    });
    expect(controller.terminal.options.minimumContrastRatio).toBe(7);

    terminalRegistry.updateOptions({
      fontSize: 14,
      fontFamily: 'system',
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      colorScheme: 'light',
      minimumContrastRatio: 1,
      autoReconnect: false,
      lineHeight: 1,
      letterSpacing: 0,
      urlDetection: true,
      bellStyle: 'none',
    });
    expect(controller.terminal.options.minimumContrastRatio).toBe(1);
  });

  it('keeps app-scheme light fallbacks in sync with the light palette in base.css', () => {
    const root = document.documentElement;
    const colors = [
      ['cursor', '--app-primary'],
      ['selectionBackground', '--app-terminal-selection'],
      ['selectionInactiveBackground', '--app-terminal-selection-inactive'],
    ] as const;
    for (const [, token] of colors) {
      root.style.removeProperty(token);
    }
    const fallback = resolveTerminalTheme('app');

    const stylesheet = new CSSStyleSheet();
    stylesheet.replaceSync(baseCss);
    const lightRules = [...stylesheet.cssRules]
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && root.matches(rule.selectorText))
      .reverse();
    const normalizeColor = (value: string) => {
      const probe = document.createElement('span');
      probe.style.color = value;
      return probe.style.color;
    };

    for (const [property, token] of colors) {
      const declared = normalizeColor(lightRules.map((rule) => rule.style.getPropertyValue(token)).find(Boolean) ?? '');
      expect(declared, `${token} should define a color in the light palette`).not.toBe('');
      expect(normalizeColor(fallback?.[property] ?? ''), token).toBe(declared);
    }
  });

  it('hides xterm 6 legacy viewport while leaving its real scrollable element available', () => {
    const controller = createController('s1');
    controller.attach(document.createElement('div'));

    const viewport = controller.terminal.element?.querySelector<HTMLElement>('.xterm-viewport');
    const scrollable = controller.terminal.element?.querySelector<HTMLElement>('.xterm-scrollable-element');
    expect(viewport).not.toBeNull();
    expect(scrollable).not.toBeNull();
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

  it('refits, resizes, and redraws an attached terminal before focusing it', async () => {
    const { invokeResizeSession } = await import('@/lib/ipc/tauri');
    const controller = createController('s1');
    controller.attach(document.createElement('div'));
    await Promise.resolve();
    await Promise.resolve();
    vi.mocked(invokeResizeSession).mockClear();
    const nextCols = controller.terminal.cols + 1;
    const nextRows = controller.terminal.rows + 1;
    const order: string[] = [];
    vi.spyOn(controller.fitAddon, 'fit').mockImplementation(() => {
      order.push('fit');
      controller.terminal.resize(nextCols, nextRows);
    });
    vi.spyOn(controller.terminal, 'refresh').mockImplementation(() => {
      order.push('refresh');
    });
    vi.spyOn(controller.terminal, 'focus').mockImplementation(() => {
      order.push('focus');
    });

    controller.focus();

    expect(order).toEqual(['fit', 'refresh', 'focus']);
    await vi.waitFor(() => {
      expect(invokeResizeSession).toHaveBeenCalledWith('s1', nextCols, nextRows);
    });
    expect(controller.terminal.refresh).toHaveBeenCalledWith(
      0,
      controller.terminal.rows - 1,
    );
  });

  it('rebinds a reconnected session without replacing its terminal or buffer', async () => {
    const { invokeWriteSession, listenToSshData } = await import('@/lib/ipc/tauri');
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
    await controller.whenOutputReady();
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

  it('dispose invalidates cached AI output before the session id is reused', () => {
    createController('s1');
    appendTerminalOutput('s1', 'password=disposed-secret\n');
    const disposedSnapshot = getRecentTerminalOutputSnapshot('s1', 20);
    expect(disposedSnapshot.content).toBe('password=[REDACTED]');

    terminalRegistry.dispose('s1');
    expect(getRecentTerminalOutput('s1', 20)).toBe('');

    createController('s1');
    appendTerminalOutput('s1', 'rebuilt session\n');
    const rebuiltSnapshot = getRecentTerminalOutputSnapshot('s1', 20);
    expect(rebuiltSnapshot).not.toBe(disposedSnapshot);
    expect(rebuiltSnapshot.content).toBe('rebuilt session');
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

  it('coalesces resize within a frame, keeps updating during a drag, and drops an unchanged grid size', async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const callbacks = new Map<ResizeObserver, ResizeObserverCallback>();
    class RecordingResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.set(this, callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): ResizeObserverEntry[] {
        return [];
      }
    }
    globalThis.ResizeObserver = RecordingResizeObserver;
    vi.useFakeTimers();

    try {
      const { invokeResizeSession } = await import('@/lib/ipc/tauri');
      const controller = createController('s1');
      Object.defineProperty(controller.container, 'offsetParent', {
        configurable: true,
        get: () => document.body,
      });
      controller.attach(document.createElement('div'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      vi.mocked(invokeResizeSession).mockClear();
      vi.spyOn(controller.fitAddon, 'proposeDimensions')
        .mockReturnValueOnce({ cols: 100, rows: 30 })
        .mockReturnValue({ cols: 101, rows: 31 });

      const resizeCallback = callbacks.get(controller.resizeObserver!)!;
      resizeCallback([], controller.resizeObserver!);
      resizeCallback([], controller.resizeObserver!);
      expect(invokeResizeSession).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersToNextFrame();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(invokeResizeSession).toHaveBeenCalledOnce();
      expect(invokeResizeSession).toHaveBeenCalledWith('s1', 101, 31);

      vi.mocked(controller.fitAddon.proposeDimensions).mockReturnValue({ cols: 102, rows: 32 });
      resizeCallback([], controller.resizeObserver!);
      await act(async () => {
        vi.advanceTimersToNextFrame();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(invokeResizeSession).toHaveBeenCalledTimes(2);
      expect(invokeResizeSession).toHaveBeenLastCalledWith('s1', 102, 32);

      resizeCallback([], controller.resizeObserver!);
      vi.advanceTimersToNextFrame();
      expect(invokeResizeSession).toHaveBeenCalledTimes(2);
    } finally {
      terminalRegistry.disposeAll();
      vi.useRealTimers();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('retries the latest resize after a transient IPC failure', async () => {
    vi.useFakeTimers();
    const { invokeResizeSession } = await import('@/lib/ipc/tauri');
    vi.mocked(invokeResizeSession)
      .mockRejectedValueOnce(new Error('transient resize failure'))
      .mockResolvedValue(undefined);

    try {
      const controller = createController('s1');
      controller.attach(document.createElement('div'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(invokeResizeSession).toHaveBeenCalledOnce();
      const initialDimensions = vi.mocked(invokeResizeSession).mock.calls[0];

      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(invokeResizeSession).toHaveBeenCalledTimes(2);
      expect(vi.mocked(invokeResizeSession).mock.calls[1]).toEqual(initialDimensions);
    } finally {
      terminalRegistry.disposeAll();
      vi.useRealTimers();
      vi.mocked(invokeResizeSession).mockReset().mockResolvedValue(undefined);
    }
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

  it('synchronizes the pty after a display preference changes the fitted grid', async () => {
    const { invokeResizeSession } = await import('@/lib/ipc/tauri');
    const controller = createController('s1');
    controller.attach(document.createElement('div'));
    await vi.waitFor(() => expect(invokeResizeSession).toHaveBeenCalled());
    vi.mocked(invokeResizeSession).mockClear();
    const nextCols = controller.terminal.cols + 2;
    const nextRows = controller.terminal.rows + 1;
    vi.spyOn(controller.fitAddon, 'fit').mockImplementation(() => {
      controller.terminal.resize(nextCols, nextRows);
    });

    controller.updateOptions({
      fontSize: 16,
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

    await vi.waitFor(() => {
      expect(invokeResizeSession).toHaveBeenCalledWith('s1', nextCols, nextRows);
    });
  });

  it('writes connected input to the session', async () => {
    const { invokeWriteSession } = await import('@/lib/ipc/tauri');
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

  it('forwards xterm binary mouse reports without UTF-8 re-encoding', async () => {
    const { invokeWriteSessionBytes } = await import('@/lib/ipc/tauri');
    const controller = createController('s1');
    const binaryCore = controller.terminal as unknown as {
      _core: { coreService: { triggerBinaryEvent(data: string): void } };
    };

    binaryCore._core.coreService.triggerBinaryEvent(String.fromCharCode(0x1b, 0x5b, 0x80));

    await vi.waitFor(() => {
      expect(invokeWriteSessionBytes).toHaveBeenCalledWith(
        's1',
        new Uint8Array([0x1b, 0x5b, 0x80]),
      );
    });
  });

  it('reports the first blocked Agent-owned input without writing into terminal history', async () => {
    const { invokeWriteSession } = await import('@/lib/ipc/tauri');
    const controller = createController('s1');
    controller.attach(document.createElement('div'));
    const writeln = vi.spyOn(controller.terminal, 'writeln');
    const firstBlocked = vi.fn();
    const secondBlocked = vi.fn();
    const releaseFirst = controller.suppressUserInput(firstBlocked);
    const releaseSecond = controller.suppressUserInput(secondBlocked);

    await expect(controller.writeUserInput('a')).resolves.toBe(false);
    await expect(controller.writeUserInput('b')).resolves.toBe(false);
    expect(invokeWriteSession).not.toHaveBeenCalled();
    expect(firstBlocked).toHaveBeenCalledOnce();
    expect(secondBlocked).toHaveBeenCalledOnce();
    expect(writeln).not.toHaveBeenCalled();

    releaseFirst();
    await expect(controller.writeUserInput('still blocked')).resolves.toBe(false);
    expect(invokeWriteSession).not.toHaveBeenCalled();
    expect(firstBlocked).toHaveBeenCalledOnce();
    expect(secondBlocked).toHaveBeenCalledOnce();
    expect(writeln).not.toHaveBeenCalled();

    releaseSecond();
    await expect(controller.writeUserInput('accepted')).resolves.toBe(true);
    expect(invokeWriteSession).toHaveBeenCalledWith('s1', 'accepted');
  });

  it('detects pending input, unverified submissions, and credential prompts for ready ACK', async () => {
    const { listenToSshData } = await import('@/lib/ipc/tauri');
    let dataHandler: ((event: TauriEvent<string>) => void) | undefined;
    vi.mocked(listenToSshData).mockImplementation(async (_sessionId, callback) => {
      dataHandler = callback;
      return () => {};
    });
    const controller = createController('s1');
    await vi.waitFor(() => expect(dataHandler).toBeDefined());

    await controller.writeUserInput('echo half');
    expect(controller.hasPendingUserInput()).toBe(true);
    await controller.writeUserInput('\r');
    expect(controller.hasPendingUserInput()).toBe(false);
    expect(controller.hasUnverifiedUserSubmission()).toBe(true);

    dataHandler!({ event: 'ssh-data:s1', id: 1, payload: 'output\r\n' });
    expect(controller.hasUnverifiedUserSubmission()).toBe(false);
    dataHandler!({ event: 'ssh-data:s1', id: 2, payload: '\u001b[33mPassword:\u001b[0m ' });
    expect(controller.hasKnownCredentialPrompt()).toBe(true);
    dataHandler!({ event: 'ssh-data:s1', id: 3, payload: 'accepted\r\n$ ' });
    expect(controller.hasKnownCredentialPrompt()).toBe(false);
    dataHandler!({
      event: 'ssh-data:s1',
      id: 4,
      payload: 'The authenticity of host cannot be established. Continue connecting (yes/no)? ',
    });
    expect(controller.hasKnownCredentialPrompt()).toBe(true);
    dataHandler!({ event: 'ssh-data:s1', id: 5, payload: 'Host key accepted\r\n$ ' });
    expect(controller.hasKnownCredentialPrompt()).toBe(false);
  });

  it('pauses backend output at the parser high watermark and resumes after draining', async () => {
    const { invokeSetSessionOutputPaused, listenToSshData } = await import('@/lib/ipc/tauri');
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

  it('retries resuming backend output after a transient IPC failure', async () => {
    const { invokeSetSessionOutputPaused, listenToSshData } = await import('@/lib/ipc/tauri');
    vi.mocked(invokeSetSessionOutputPaused)
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('transient resume failure'))
      .mockResolvedValue(undefined);
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
    parsedCallbacks.forEach((callback) => callback());

    await vi.waitFor(() => {
      const resumeCalls = vi.mocked(invokeSetSessionOutputPaused).mock.calls
        .filter(([, paused]) => paused === false);
      expect(resumeCalls).toHaveLength(2);
    }, { timeout: 1500 });
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
    const { invokeWriteSession } = await import('@/lib/ipc/tauri');
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
    const { invokeWriteSession } = await import('@/lib/ipc/tauri');
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
      const { listenToSshClosed } = await import('@/lib/ipc/tauri');
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
        await vi.advanceTimersByTimeAsync(1500);
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
        await vi.advanceTimersByTimeAsync(1500);
      });
      // The closed stream's listener was invalidated. Its stale event must not
      // schedule a new reconnect; an explicit user retry uses the released guard.
      expect(requestReconnect).toHaveBeenCalledTimes(1);
      controller.simulateInput('\r');
      expect(requestReconnect).toHaveBeenCalledTimes(2);
      expect(requestReconnect).toHaveBeenLastCalledWith('s1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps readOnly enforcement across rebindSession and after unlocking/re-locking', async () => {
    const ipc = await import('@/lib/ipc/tauri');
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 's1', title: 'Locked', host: 'h', port: 22, username: 'u' });
    store.setStatus('s1', { sessionId: 's1', status: 'connected' });
    store.toggleReadOnly('s1');

    const controller = createController('s1');
    controller.attach(document.createElement('div'));

    await expect(controller.writeUserInput('ls\r')).resolves.toBe(false);
    await expect(controller.writeUserBinaryInput(new Uint8Array([0x03]))).resolves.toBe(false);
    expect(ipc.invokeWriteSession).not.toHaveBeenCalled();
    expect(ipc.invokeWriteSessionBytes).not.toHaveBeenCalled();

    terminalRegistry.rebindSession('s1', 's2');
    store.reconnectSession('s1', { sessionId: 's2', title: 'Locked', host: 'h', port: 22, username: 'u' });
    store.setStatus('s2', { sessionId: 's2', status: 'connected' });
    await controller.whenOutputReady();
    terminalInputReadiness.finish('s2');

    await expect(controller.writeUserInput('rm -rf /\r')).resolves.toBe(false);
    await expect(controller.writeUserBinaryInput(new Uint8Array([0x03]))).resolves.toBe(false);
    expect(ipc.invokeWriteSession).not.toHaveBeenCalled();
    expect(ipc.invokeWriteSessionBytes).not.toHaveBeenCalled();

    store.toggleReadOnly('s2');
    await expect(controller.writeUserInput('pwd\r')).resolves.toBe(true);
    expect(ipc.invokeWriteSession).toHaveBeenCalledWith('s2', 'pwd\r');

    store.toggleReadOnly('s2');
    await expect(controller.writeUserInput('id\r')).resolves.toBe(false);
    expect(ipc.invokeWriteSession).toHaveBeenCalledTimes(1);
  });

  it('keeps readOnly enforcement when locked for the first time after rebindSession', async () => {
    const ipc = await import('@/lib/ipc/tauri');
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 's1', title: 'Writable', host: 'h', port: 22, username: 'u' });
    store.setStatus('s1', { sessionId: 's1', status: 'connected' });

    const controller = createController('s1');
    controller.attach(document.createElement('div'));

    terminalRegistry.rebindSession('s1', 's2');
    store.reconnectSession('s1', { sessionId: 's2', title: 'Writable', host: 'h', port: 22, username: 'u' });
    store.setStatus('s2', { sessionId: 's2', status: 'connected' });
    await controller.whenOutputReady();
    terminalInputReadiness.finish('s2');

    await expect(controller.writeUserInput('echo ok\r')).resolves.toBe(true);
    expect(ipc.invokeWriteSession).toHaveBeenCalledWith('s2', 'echo ok\r');

    store.toggleReadOnly('s2');
    await expect(controller.writeUserInput('whoami\r')).resolves.toBe(false);
    expect(ipc.invokeWriteSession).toHaveBeenCalledTimes(1);
  });

  it('re-arms suppressUserInput feedback across consecutive leases and ignores keys while readOnly', async () => {
    const { invokeWriteSession } = await import('@/lib/ipc/tauri');
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 's1', title: 'Test', host: 'h', port: 22, username: 'u' });
    store.setStatus('s1', { sessionId: 's1', status: 'connected' });

    const controller = createController('s1');
    controller.attach(document.createElement('div'));

    const firstLeaseBlocked = vi.fn();
    const releaseFirst = controller.suppressUserInput(firstLeaseBlocked);
    await expect(controller.writeUserInput('a')).resolves.toBe(false);
    expect(firstLeaseBlocked).toHaveBeenCalledTimes(1);
    releaseFirst();

    const secondLeaseBlocked = vi.fn();
    const releaseSecond = controller.suppressUserInput(secondLeaseBlocked);
    await expect(controller.writeUserInput('b')).resolves.toBe(false);
    expect(secondLeaseBlocked).toHaveBeenCalledTimes(1);
    releaseSecond();

    store.toggleReadOnly('s1');
    const thirdLeaseBlocked = vi.fn();
    const releaseThird = controller.suppressUserInput(thirdLeaseBlocked);
    await expect(controller.writeUserInput('c')).resolves.toBe(false);
    expect(thirdLeaseBlocked).not.toHaveBeenCalled();

    store.toggleReadOnly('s1');
    await expect(controller.writeUserInput('d')).resolves.toBe(false);
    expect(thirdLeaseBlocked).toHaveBeenCalledTimes(1);
    releaseThird();

    await expect(controller.writeUserInput('ok')).resolves.toBe(true);
    expect(invokeWriteSession).toHaveBeenCalledWith('s1', 'ok');
  });

  it('omits reconnect-by-Enter hints for readOnly disconnected or failed sessions', async () => {
    const { listenToSshClosed } = await import('@/lib/ipc/tauri');
    let closedHandler: ((event: any) => void) | undefined;
    vi.mocked(listenToSshClosed).mockImplementation(async (_sessionId, callback) => {
      closedHandler = callback;
      return () => {};
    });

    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 's1', title: 'Locked', host: 'h', port: 22, username: 'u' });
    store.toggleReadOnly('s1');

    const requestReconnect = vi.fn();
    const controller = terminalRegistry.create('s1', vi.fn(), vi.fn(), () => 'disconnected', requestReconnect);
    await controller.whenOutputReady();

    controller.writeDisconnectedHint();
    controller.writeConnectionFailure('boom');
    closedHandler!({ payload: { sessionId: 's1', reasonKind: 'transport_disconnect', retryable: true } });
    await act(async () => { await Promise.resolve(); });
    await new Promise<void>((resolve) => controller.terminal.write('', resolve));

    const buffer = controller.terminal.buffer.active;
    const content = Array.from(
      { length: buffer.length },
      (_, index) => buffer.getLine(index)?.translateToString(true) ?? '',
    ).join('\n');
    expect(content).toContain(t('terminal.notice.closedLabel'));
    expect(content).not.toContain(t('terminal.notice.disconnectedHint'));
    expect(content).not.toContain(t('terminal.notice.connectionFailedHint'));
    expect(content).not.toContain(t('terminal.notice.pressEnterReconnect'));

    controller.simulateInput('\r');
    expect(requestReconnect).not.toHaveBeenCalled();
  });

  it('broadcasts user input without forwarding protocol auto-replies and delivers paste to unopened targets', async () => {
    const { invokeWriteSession } = await import('@/lib/ipc/tauri');
    const store = useTerminalStore.getState();
    for (const id of ['s1', 's2', 's3']) {
      store.addSession({ sessionId: id, title: id, host: 'h', port: 22, username: 'u' });
      store.setStatus(id, { sessionId: id, status: 'connected' });
    }
    const c1 = createController('s1');
    const c2 = createController('s2');
    const c3 = createController('s3');
    const host = document.createElement('div');
    document.body.appendChild(host);
    try {
      c1.attach(host);
      await Promise.all([c1.whenOutputReady(), c2.whenOutputReady(), c3.whenOutputReady()]);
      useTerminalBroadcastStore.getState().configure('custom', ['s1', 's2', 's3']);

      await expect(c1.writeUserInput('ls\r', true)).resolves.toBe(true);
      await act(async () => { await Promise.resolve(); });
      expect(invokeWriteSession).toHaveBeenCalledWith('s1', 'ls\r');
      expect(invokeWriteSession).toHaveBeenCalledWith('s2', 'ls\r');
      expect(invokeWriteSession).toHaveBeenCalledWith('s3', 'ls\r');

      vi.mocked(invokeWriteSession).mockClear();
      await new Promise<void>((resolve) => c1.terminal.write('\u001b[6n', resolve));
      await act(async () => { await Promise.resolve(); });
      expect(invokeWriteSession).toHaveBeenCalledTimes(1);
      expect(invokeWriteSession).toHaveBeenCalledWith('s1', '\u001b[1;1R');

      vi.mocked(invokeWriteSession).mockClear();
      await new Promise<void>((resolve) => c2.terminal.write('\u001b[?2004h', resolve));
      c1.pasteUserText('echo 1\necho 2', true);
      await act(async () => { await Promise.resolve(); });

      expect(invokeWriteSession).toHaveBeenCalledTimes(3);
      expect(invokeWriteSession).toHaveBeenCalledWith('s1', 'echo 1\recho 2');
      expect(invokeWriteSession).toHaveBeenCalledWith('s2', '\u001b[200~echo 1\recho 2\u001b[201~');
      expect(invokeWriteSession).toHaveBeenCalledWith('s3', 'echo 1\recho 2');

      vi.mocked(invokeWriteSession).mockClear();
      c1.pasteUserText('safe\u001b[201~evil\u009b201~tail', true);
      await act(async () => { await Promise.resolve(); });
      expect(invokeWriteSession).toHaveBeenCalledWith('s1', 'safeeviltail');
      expect(invokeWriteSession).toHaveBeenCalledWith('s2', '\u001b[200~safeeviltail\u001b[201~');
    } finally {
      useTerminalBroadcastStore.getState().configure('off');
      host.remove();
    }
  });

  it('restricts OSC 52 clipboard writes to attached active focused terminal and rate limits them', async () => {
    const writeSpy = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeSpy, readText: vi.fn().mockResolvedValue('') },
    });

    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 'osc-active', title: 'osc-active', host: 'h', port: 22, username: 'u' });
    store.setStatus('osc-active', { sessionId: 'osc-active', status: 'connected' });
    store.setActiveSession('osc-active');
    useAppStore.setState({ activeSection: 'terminal', terminalOsc52Policy: 'writeOnly' });

    const controller = createController('osc-active');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const hasFocusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      await controller.whenOutputReady();
      // Detached controller must not write clipboard.
      await new Promise<void>((resolve) => controller.terminal.write('\u001b]52;c;aGVsbG8=\u0007', resolve));
      expect(writeSpy).not.toHaveBeenCalled();

      controller.attach(host);
      // Hidden section must not write clipboard.
      useAppStore.setState({ activeSection: 'workbench' });
      await new Promise<void>((resolve) => controller.terminal.write('\u001b]52;c;aGVsbG8=\u0007', resolve));
      expect(writeSpy).not.toHaveBeenCalled();

      // Active visible focused terminal may write up to rate limit.
      useAppStore.setState({ activeSection: 'terminal' });
      for (let i = 0; i < 6; i += 1) {
        await new Promise<void>((resolve) => controller.terminal.write('\u001b]52;c;aGVsbG8=\u0007', resolve));
      }
      expect(writeSpy).toHaveBeenCalledTimes(4);
      expect(writeSpy).toHaveBeenCalledWith('hello');
    } finally {
      hasFocusSpy.mockRestore();
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
      host.remove();
    }
  });

  it('still marks rebound session ready after transient resize failure and drops stale outputFilters', async () => {
    const { invokeMarkSessionReady, invokeResizeSession, listenToSshData } = await import('@/lib/ipc/tauri');
    const dataCallbacks = new Map<string, (event: TauriEvent<string>) => void>();
    vi.mocked(listenToSshData).mockImplementation(async (sessionId, callback) => {
      dataCallbacks.set(sessionId, callback);
      return () => { dataCallbacks.delete(sessionId); };
    });
    const store = useTerminalStore.getState();
    store.addSession({ sessionId: 'rebind-old', title: 'old', host: 'h', port: 22, username: 'u' });
    store.setStatus('rebind-old', { sessionId: 'rebind-old', status: 'connected' });
    store.addSession({ sessionId: 'rebind-new', title: 'new', host: 'h', port: 22, username: 'u' });
    store.setStatus('rebind-new', { sessionId: 'rebind-new', status: 'connected' });

    const controller = createController('rebind-old');
    await controller.whenOutputReady();
    // Install a filter that swallows everything on the old session.
    controller.subscribeOutputFilter({ push: () => '', finish: () => '' });

    vi.mocked(invokeMarkSessionReady).mockClear();
    vi.mocked(invokeResizeSession).mockRejectedValueOnce(new Error('transient resize failure'));

    terminalRegistry.rebindSession('rebind-old', 'rebind-new');
    await controller.whenOutputReady();

    expect(invokeMarkSessionReady).toHaveBeenCalledWith('rebind-new');

    // Replacement session output must not be swallowed by the old outputFilter.
    const received: string[] = [];
    controller.subscribeDisplayOutput(({ source, data }) => {
      if (source === 'session') received.push(data);
    });
    dataCallbacks.get('rebind-new')?.({ payload: 'fresh-output' } as TauriEvent<string>);
    expect(received.join('')).toContain('fresh-output');
  });

  it('deduplicates broadcast write failure toasts and alerts when a target rejects input', async () => {
    const { invokeWriteSession } = await import('@/lib/ipc/tauri');
    const store = useTerminalStore.getState();
    for (const id of ['s1', 's2']) {
      store.addSession({ sessionId: id, title: id, host: 'h', port: 22, username: 'u' });
      store.setStatus(id, { sessionId: id, status: 'connected' });
    }
    const c1 = createController('s1');
    const c2 = createController('s2');
    try {
      await Promise.all([c1.whenOutputReady(), c2.whenOutputReady()]);
      useTerminalBroadcastStore.getState().configure('custom', ['s1', 's2']);

      vi.mocked(invokeWriteSession).mockImplementation((sessionId) => (
        sessionId === 's2' ? Promise.reject(new Error('channel closed')) : Promise.resolve()
      ));
      await c1.writeUserInput('a', true);
      await c1.writeUserInput('b', true);
      await act(async () => { await Promise.resolve(); });

      const broadcastErrors = () => useToastStore.getState().toasts.filter(
        (toast) => toast.variant === 'error' && toast.message === t('terminal.broadcast.writeFailed'),
      );
      expect(broadcastErrors()).toHaveLength(1);

      useToastStore.setState({ toasts: [] });
      vi.mocked(invokeWriteSession).mockResolvedValue(undefined);
      const release = c2.suppressUserInput();
      try {
        await c1.writeUserInput('c', true);
        await act(async () => { await Promise.resolve(); });
        expect(broadcastErrors()).toHaveLength(1);
      } finally {
        release();
      }
    } finally {
      useTerminalBroadcastStore.getState().configure('off');
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

  it('maps links after wide cells to terminal columns', async () => {
    const controller = createController('wide-link');
    controller.terminal.resize(40, 4);
    await new Promise<void>((resolve) => {
      controller.terminal.write('你 https://example.com', resolve);
    });

    expect(findHttpLinksInBuffer(controller.terminal.buffer.active, 1, 40)).toEqual([{
      text: 'https://example.com',
      range: {
        start: { x: 4, y: 1 },
        end: { x: 22, y: 1 },
      },
    }]);
  });

  it('returns one complete link across wrapped buffer rows', async () => {
    const controller = createController('wrapped-link');
    controller.terminal.resize(12, 4);
    await new Promise<void>((resolve) => {
      controller.terminal.write('https://example.com', resolve);
    });

    expect(findHttpLinksInBuffer(controller.terminal.buffer.active, 2, 12)).toEqual([{
      text: 'https://example.com',
      range: {
        start: { x: 1, y: 1 },
        end: { x: 7, y: 2 },
      },
    }]);
  });

  it('requires a modifier key before activating terminal links', async () => {
    const { invokeOpenUrl, invokeRevealPath } = await import('@/lib/ipc/tauri');
    const platformSpy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const registerSpy = vi.spyOn(Terminal.prototype, 'registerLinkProvider');
    try {
      const controller = createController('modifier-link');
      useTerminalStore.getState().addSession({
        sessionId: 'modifier-link',
        title: 'Local',
        host: 'local',
        port: 0,
        username: 'dev',
      });
      const provider = registerSpy.mock.calls[registerSpy.mock.calls.length - 1]?.[0];
      expect(provider).toBeDefined();

      controller.terminal.resize(60, 4);
      await new Promise<void>((resolve) => {
        controller.terminal.write('/var/log/test.log https://example.com', resolve);
      });

      const links = await new Promise<ILink[] | undefined>((resolve) => {
        provider!.provideLinks(1, (found: ILink[] | undefined) => resolve(found));
      });
      const fileLink = links?.find((link) => link.text === '/var/log/test.log');
      const urlLink = links?.find((link) => link.text === 'https://example.com');
      expect(fileLink).toBeDefined();
      expect(urlLink).toBeDefined();

      // Plain click must not trigger link navigation.
      fileLink!.activate(new MouseEvent('click'), fileLink!.text);
      urlLink!.activate(new MouseEvent('click'), urlLink!.text);
      controller.terminal.options.linkHandler?.activate(new MouseEvent('click'), 'https://example.com', {
        start: { x: 1, y: 1 },
        end: { x: 19, y: 1 },
      });
      expect(invokeRevealPath).not.toHaveBeenCalled();
      expect(invokeOpenUrl).not.toHaveBeenCalled();

      // Cmd+Click on macOS activates file and URL links.
      fileLink!.activate(new MouseEvent('click', { metaKey: true }), fileLink!.text);
      urlLink!.activate(new MouseEvent('click', { metaKey: true }), urlLink!.text);
      expect(invokeRevealPath).toHaveBeenCalledWith('/var/log/test.log');
      expect(invokeOpenUrl).toHaveBeenCalledWith('https://example.com');
    } finally {
      registerSpy.mockRestore();
      platformSpy.mockRestore();
    }
  });
});
