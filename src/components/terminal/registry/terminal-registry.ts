import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import {
  invokeGetSessionStatus,
  invokeMarkSessionReady,
  invokeResizeSession,
  invokeWriteSession,
  invokeOpenUrl,
  listenToSshClosed,
  listenToSshData,
  listenToSshStatus,
} from '@/lib/tauri';
import { formatTerminalNoticeLine, formatTerminalStatusLine, shouldDisableTerminalInput, shouldReconnectFromInput } from '@/lib/terminal';
import { t } from '@/locales';
import { createLogger } from '@/lib/logger';
import type {
  ClosedEvent,
  SessionStatus,
  StatusEvent,
  TerminalBellStyle,
  TerminalColorScheme,
  TerminalCursorStyle,
  TerminalFontFamily,
} from '@/types';
import type { IDisposable, ILink } from '@xterm/xterm';

const logger = createLogger('terminal');

export type StatusCallback = (sessionId: string, payload: StatusEvent) => void;
export type ClosedCallback = (sessionId: string, payload: ClosedEvent) => void;
export type GetStatusCallback = (sessionId: string) => SessionStatus;
export type RequestReconnectCallback = (sessionId: string) => void;

export interface TerminalDisplayPreferences {
  fontSize: number;
  fontFamily: TerminalFontFamily;
  cursorBlink: boolean;
  cursorStyle: TerminalCursorStyle;
  scrollback: number;
  colorScheme: TerminalColorScheme;
  autoReconnect: boolean;
  lineHeight: number;
  letterSpacing: number;
  urlDetection: boolean;
  bellStyle: TerminalBellStyle;
}

const TERMINAL_FONT_FAMILIES: Record<TerminalFontFamily, string> = {
  system: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  menlo: 'Menlo, monospace',
  monaco: 'Monaco, monospace',
  consolas: 'Consolas, monospace',
  courierNew: '"Courier New", monospace',
};

const DEFAULT_TERMINAL_PREFERENCES: TerminalDisplayPreferences = {
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
};

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

const RESIZE_DEBOUNCE_MS = 100;

// After a reconnect the channel reports connected while the remote shell is
// still starting up (sourcing rc files, printing its first prompt). Input
// sent in that window is echoed into the middle of the prompt output,
// leaving garbled duplicate prompt lines, so it is dropped briefly.
const RECONNECT_INPUT_GRACE_MS = 800;

// Hides the DOM renderer's scroll viewport layer. With the webgl renderer
// the viewport only carries the scrollbar, so it must stay visible.
const VIEWPORT_HIDDEN_CLASS = '[&_.xterm-viewport]:opacity-0';

type RendererMode = 'webgl' | 'dom';

function trimUrlPunctuation(url: string): string {
  return url.replace(/[),.;!?\]}]+$/g, '');
}

export function findHttpLinksInLine(line: string): Array<{ text: string; start: number; end: number }> {
  const links: Array<{ text: string; start: number; end: number }> = [];
  for (const match of line.matchAll(URL_PATTERN)) {
    if (match.index === undefined) continue;
    const text = trimUrlPunctuation(match[0]);
    if (!text) continue;
    links.push({ text, start: match.index + 1, end: match.index + text.length });
  }
  return links;
}

function playBellSound(): void {
  const AudioContextConstructor = window.AudioContext;
  if (!AudioContextConstructor) return;
  const context = new AudioContextConstructor();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 880;
  gain.gain.setValueAtTime(0.05, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.08);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.08);
  oscillator.addEventListener('ended', () => void context.close(), { once: true });
}

const TERMINAL_COLOR_SCHEMES: Record<TerminalColorScheme, NonNullable<ConstructorParameters<typeof Terminal>[0]>['theme']> = {
  app: {
    background: '#000000',
    foreground: 'var(--app-text)',
    cursor: 'var(--app-primary)',
  },
  oneDark: {
    background: '#282c34',
    foreground: '#abb2bf',
    cursor: '#528bff',
    black: '#282c34',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
  },
  solarizedDark: {
    background: '#002b36',
    foreground: '#839496',
    cursor: '#93a1a1',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#0969da',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#4d2d00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#f6f8fa',
  },
};

export interface TerminalController {
  sessionId: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  container: HTMLDivElement;
  host: HTMLElement | null;
  resizeObserver: ResizeObserver | null;
  unlisten: {
    data: (() => void) | undefined;
    status: (() => void) | undefined;
    closed: (() => void) | undefined;
  };
  attach(host: HTMLElement): void;
  detach(): void;
  focus(): void;
  simulateInput(data: string): void;
  write(chunk: string): void;
  writeDisconnectedHint(): void;
  rebindSession(sessionId: string): void;
  updateOptions(preferences: TerminalDisplayPreferences): void;
  dispose(): void;
}

class TerminalControllerImpl implements TerminalController {
  private readonly removeFromRegistry: (sessionId: string) => void;
  sessionId: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  container: HTMLDivElement;
  host: HTMLElement | null = null;
  resizeObserver: ResizeObserver | null = null;
  unlisten: TerminalController['unlisten'];
  private opened = false;
  private disposed = false;
  private readonly setStatus: StatusCallback;
  private readonly setClosed: ClosedCallback;
  private readonly getStatus: GetStatusCallback;
  private readonly requestReconnect: RequestReconnectCallback;
  private inputBlockedNoticeRef = false;
  private reconnectRequestedRef = false;
  private inputGraceDeadlineRef = 0;
  private listenerGeneration = 0;
  private preferences: TerminalDisplayPreferences;
  private linkProviderDisposable?: IDisposable;
  private resizeDebounceTimer: number | null = null;
  private pendingDimensions: { cols: number; rows: number } | null = null;
  // Last size forwarded to the pty. The backend relays every resize as an
  // SSH window-change even when the size is unchanged, and the resulting
  // SIGWINCH makes the remote shell redraw its prompt — sometimes leaving
  // duplicated/garbled prompt lines — so identical resizes are dropped here.
  private lastSentDimensions: { cols: number; rows: number } | null = null;
  private rendererMode: RendererMode = 'dom';
  private rendererInitialized = false;

  constructor(
    sessionId: string,
    setStatus: StatusCallback,
    setClosed: ClosedCallback,
    getStatus: GetStatusCallback,
    requestReconnect: RequestReconnectCallback,
    removeFromRegistry: (sessionId: string) => void,
    preferences: TerminalDisplayPreferences,
  ) {
    this.sessionId = sessionId;
    this.setStatus = setStatus;
    this.setClosed = setClosed;
    this.getStatus = getStatus;
    this.requestReconnect = requestReconnect;
    this.removeFromRegistry = removeFromRegistry;
    this.preferences = preferences;

    this.terminal = new Terminal({
      fontFamily: TERMINAL_FONT_FAMILIES[preferences.fontFamily],
      fontSize: preferences.fontSize,
      theme: TERMINAL_COLOR_SCHEMES[preferences.colorScheme],
      cursorBlink: preferences.cursorBlink,
      cursorStyle: preferences.cursorStyle,
      scrollback: preferences.scrollback,
      lineHeight: preferences.lineHeight,
      letterSpacing: preferences.letterSpacing,
    });
    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);

    this.container = document.createElement('div');
    this.container.className = 'h-full w-full [&_.xterm-viewport]:opacity-0 [&>.terminal.xterm]:h-full [&>.terminal.xterm]:p-1';

    this.unlisten = {
      data: undefined,
      status: undefined,
      closed: undefined,
    };

    this.terminal.onData((data) => {
      this.handleInput(data);
    });
    this.terminal.onBell(() => {
      if (this.preferences.bellStyle === 'sound') playBellSound();
    });
    this.updateLinkProvider();

    void this.setupListeners();
  }

  private handleInput(data: string): void {
    const status = this.getStatus(this.sessionId);

    if (status === 'connected') {
      if (Date.now() < this.inputGraceDeadlineRef) {
        logger.debug(`Dropped input during post-reconnect grace period session=${this.sessionId}`);
        return;
      }
      void invokeWriteSession(this.sessionId, data).catch((error) => {
        logger.error(`Failed to write input to session ${this.sessionId}`, error);
        this.writeSystemLine(formatTerminalNoticeLine(t('terminal.notice.writeFailedLabel'), t('terminal.notice.writeFailedMessage'), '31'));
      });
      return;
    }

    // While the session is still connecting the pane shows a connecting
    // overlay, so stray keystrokes are dropped silently instead of printing a
    // misleading "disconnected" hint.
    if (shouldDisableTerminalInput(status)) {
      return;
    }

    if (shouldReconnectFromInput(status, data)) {
      if (!this.reconnectRequestedRef) {
        this.reconnectRequestedRef = true;
        // The password dialog (if needed) or the ReconnectingIndicator/Ui
        // provides immediate feedback, so we skip writing a system line here.
        Promise.resolve(this.requestReconnect(this.sessionId)).finally(() => {
          if (this.disposed) return;
          this.reconnectRequestedRef = false;
        });
      }
      return;
    }

    if (!this.inputBlockedNoticeRef) {
      this.writeSystemLine(formatTerminalNoticeLine(t('terminal.notice.hintLabel'), t('terminal.notice.disconnectedHint')));
      this.inputBlockedNoticeRef = true;
    }
  }

  private updateElementStyles(): void {
    const element = this.terminal.element;
    if (!element) return;

    element.style.width = '100%';
    element.style.height = '100%';

    const background = TERMINAL_COLOR_SCHEMES[this.preferences.colorScheme]?.background;
    const viewport = element.querySelector<HTMLElement>('.xterm-viewport');
    if (background) {
      element.style.setProperty('background-color', background, 'important');
      viewport?.style.setProperty('background-color', background, 'important');
    } else {
      element.style.removeProperty('background-color');
      viewport?.style.removeProperty('background-color');
    }
  }

  // Renderer addons need the terminal element, so they are loaded once after
  // the first successful open().
  // NOTE: the WebGL renderer (@xterm/addon-webgl) is temporarily disabled;
  // the DOM renderer is always used. To restore it, re-add the WebglAddon
  // import and the try/catch block that loads it here.
  private setupRenderer(): void {
    if (this.rendererInitialized) return;
    this.rendererInitialized = true;
    this.setRendererMode('dom');
  }

  private setRendererMode(mode: RendererMode): void {
    this.rendererMode = mode;
    this.container.classList.toggle(VIEWPORT_HIDDEN_CLASS, mode === 'dom');
  }

  private writeSystemLine(line: string): void {
    if (this.disposed) return;
    this.terminal.writeln(line);
  }

  private updateLinkProvider(): void {
    this.linkProviderDisposable?.dispose();
    this.linkProviderDisposable = undefined;
    if (!this.preferences.urlDetection) return;
    this.linkProviderDisposable = this.terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const line = this.terminal.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true);
        if (!line) {
          callback(undefined);
          return;
        }
        const links: ILink[] = [];
        for (const detected of findHttpLinksInLine(line)) {
          links.push({
            text: detected.text,
            range: {
              start: { x: detected.start, y: bufferLineNumber },
              end: { x: detected.end, y: bufferLineNumber },
            },
            decorations: { pointerCursor: true, underline: true },
            activate: (_event, text) => {
              void invokeOpenUrl(text).catch((error) => {
                logger.warn(`Failed to open terminal URL: ${text}`, error);
              });
            },
          });
        }
        callback(links.length > 0 ? links : undefined);
      },
    });
  }

  private resetNoticeState(): void {
    this.inputBlockedNoticeRef = false;
    this.reconnectRequestedRef = false;
  }

  private clearListeners(): number {
    this.listenerGeneration += 1;
    this.unlisten.data?.();
    this.unlisten.status?.();
    this.unlisten.closed?.();
    this.unlisten = { data: undefined, status: undefined, closed: undefined };
    return this.listenerGeneration;
  }

  private async setupListeners(): Promise<void> {
    const generation = this.listenerGeneration;
    const sessionId = this.sessionId;
    const dataUnlisten = await listenToSshData(sessionId, (event) => {
      this.terminal.write(event.payload);
    });
    if (this.disposed || generation !== this.listenerGeneration) {
      dataUnlisten();
      return;
    }
    this.unlisten.data = dataUnlisten;

    const statusUnlisten = await listenToSshStatus(sessionId, (event) => {
      logger.info(`Session ${sessionId} status: ${event.payload.status}`);
      this.setStatus(sessionId, event.payload);
      this.writeSystemLine(formatTerminalStatusLine(event.payload.status, event.payload.message));
      if (event.payload.status === 'connected' || event.payload.status === 'error') {
        this.resetNoticeState();
      }
    });
    if (this.disposed || generation !== this.listenerGeneration) {
      statusUnlisten();
      return;
    }
    this.unlisten.status = statusUnlisten;

    const closedUnlisten = await listenToSshClosed(sessionId, (event) => {
      logger.info(`Session ${sessionId} closed${event.payload.reason ? `: ${event.payload.reason}` : ''}`);
      this.setClosed(sessionId, event.payload);
      this.writeSystemLine(
        formatTerminalNoticeLine(t('terminal.notice.closedLabel'), event.payload.reason ? `: ${event.payload.reason}` : undefined, '31'),
      );
      this.writeSystemLine(formatTerminalNoticeLine(t('terminal.notice.hintLabel'), t('terminal.notice.pressEnterReconnect')));
      this.inputBlockedNoticeRef = true;
      if (event.payload.retryable && this.preferences.autoReconnect && !this.reconnectRequestedRef) {
        this.reconnectRequestedRef = true;
        window.setTimeout(() => {
          if (this.disposed) return;
          this.writeSystemLine(formatTerminalNoticeLine(t('terminal.notice.reconnectingLabel'), t('terminal.notice.reconnectingMessage'), '36'));
          this.requestReconnect(this.sessionId);
        }, 1500);
      }
    });
    if (this.disposed || generation !== this.listenerGeneration) {
      closedUnlisten();
      return;
    }
    this.unlisten.closed = closedUnlisten;

    try {
      const snapshot = await invokeGetSessionStatus(sessionId);
      if (!this.disposed && generation === this.listenerGeneration && this.getStatus(sessionId) === 'connecting') {
        logger.info(`Session ${sessionId} reconciled status: ${snapshot.status}`);
        this.setStatus(sessionId, snapshot);
        this.writeSystemLine(formatTerminalStatusLine(snapshot.status, snapshot.message));
        if (snapshot.status === 'connected' || snapshot.status === 'error') {
          this.resetNoticeState();
        }
      }
    } catch (error) {
      if (!this.disposed && generation === this.listenerGeneration) {
        logger.warn(`Failed to reconcile session ${sessionId} status`, error);
      }
    }

    // All listeners are attached; tell the backend it may release any
    // output it buffered while we were subscribing. On Windows this also
    // delivers ConPTY's startup cursor query so the shell can proceed.
    void invokeMarkSessionReady(sessionId).catch((error) => {
      logger.warn(`Failed to mark session ${sessionId} ready`, error);
    });
  }

  attach(host: HTMLElement): void {
    if (this.host !== null && this.host !== host) {
      this.detach();
    }

    host.appendChild(this.container);

    if (!this.opened) {
      try {
        this.terminal.open(this.container);
        this.opened = true;
      } catch {
        // jsdom: open() may fail when host is detached. xterm buffers
        // writes before open(), so write() still accumulates buffer.
      }
    }

    if (this.opened) {
      this.setupRenderer();
    }

    this.updateElementStyles();

    try {
      this.fitAddon.fit();
    } catch {
      // fit() can fail without a measurable container; harmless.
    }

    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.container.offsetParent === null) return;
        const dimensions = this.fitAddon.proposeDimensions();
        if (!dimensions) return;
        if (dimensions.cols === this.terminal.cols && dimensions.rows === this.terminal.rows) {
          // Grid size unchanged (most drag frames): nothing to do — the pty
          // size is unchanged too, so no IPC either.
          return;
        }
        // Debounce the reflow itself, not just the IPC: with the webgl
        // renderer each terminal.resize() updates the canvas CSS size
        // immediately while the glyph texture is redrawn one frame later, so
        // resizing on every drag frame shows the old texture squeezed into
        // the new size — a constant compression flicker. Coalescing to a
        // single reflow once the size settles avoids it; overflow is simply
        // clipped while dragging.
        this.pendingDimensions = dimensions;
        if (this.resizeDebounceTimer !== null) {
          window.clearTimeout(this.resizeDebounceTimer);
        }
        this.resizeDebounceTimer = window.setTimeout(() => {
          this.resizeDebounceTimer = null;
          if (this.disposed) return;
          const pending = this.pendingDimensions;
          this.pendingDimensions = null;
          if (!pending) return;
          try {
            this.terminal.resize(pending.cols, pending.rows);
          } catch {
            // resize() can fail mid-teardown; harmless.
          }
          this.sendResize(pending.cols, pending.rows);
        }, RESIZE_DEBOUNCE_MS);
      });
      this.resizeObserver.observe(this.container);
    }

    // Initial resize now that cols/rows are measurable after open().
    if (this.opened) {
      this.sendResize(this.terminal.cols, this.terminal.rows);
    }

    this.host = host;
  }

  detach(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.cancelPendingResize();
    this.container.remove();
    this.host = null;
  }

  // Drop any scheduled debounced resize so a disposed or rebound
  // controller never reflows or sends a resize IPC for a stale session.
  private cancelPendingResize(): void {
    if (this.resizeDebounceTimer !== null) {
      window.clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = null;
    }
    this.pendingDimensions = null;
  }

  private sendResize(cols: number, rows: number): void {
    const last = this.lastSentDimensions;
    if (last && last.cols === cols && last.rows === rows) return;
    this.lastSentDimensions = { cols, rows };
    invokeResizeSession(this.sessionId, cols, rows).catch((error) => {
      logger.warn(`Failed to resize session ${this.sessionId}`, error);
    });
  }

  focus(): void {
    if (this.disposed) return;
    try {
      this.terminal.focus();
    } catch {
      // Ignore focus failures on disposed or hidden terminals.
    }
  }

  simulateInput(data: string): void {
    this.handleInput(data);
  }

  write(chunk: string): void {
    this.terminal.write(chunk);
  }

  writeDisconnectedHint(): void {
    this.writeSystemLine(formatTerminalNoticeLine(t('terminal.notice.hintLabel'), t('terminal.notice.disconnectedHint')));
    this.inputBlockedNoticeRef = true;
  }

  rebindSession(sessionId: string): void {
    if (this.disposed || sessionId === this.sessionId) return;
    this.clearListeners();
    this.cancelPendingResize();
    this.sessionId = sessionId;
    this.resetNoticeState();
    this.inputGraceDeadlineRef = Date.now() + RECONNECT_INPUT_GRACE_MS;
    void this.setupListeners();
  }

  updateOptions(preferences: TerminalDisplayPreferences): void {
    if (this.disposed) return;
    this.preferences = preferences;
    this.terminal.options.fontSize = preferences.fontSize;
    this.terminal.options.fontFamily = TERMINAL_FONT_FAMILIES[preferences.fontFamily];
    this.terminal.options.cursorBlink = preferences.cursorBlink;
    this.terminal.options.cursorStyle = preferences.cursorStyle;
    this.terminal.options.scrollback = preferences.scrollback;
    this.terminal.options.theme = TERMINAL_COLOR_SCHEMES[preferences.colorScheme];
    this.updateElementStyles();
    this.terminal.options.lineHeight = preferences.lineHeight;
    this.terminal.options.letterSpacing = preferences.letterSpacing;
    this.updateLinkProvider();
    if (this.host) {
      try {
        this.fitAddon.fit();
      } catch {
        // The host can briefly be unmeasurable while switching sections.
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    logger.debug(`Terminal disposed for session ${this.sessionId}`);
    this.detach();
    this.clearListeners();
    this.linkProviderDisposable?.dispose();
    this.terminal.dispose();
    this.removeFromRegistry(this.sessionId);
  }
}

interface TerminalRegistry {
  create(
    sessionId: string,
    setStatus: StatusCallback,
    setClosed: ClosedCallback,
    getStatus: GetStatusCallback,
    requestReconnect: RequestReconnectCallback,
  ): TerminalController;
  get(sessionId: string): TerminalController | undefined;
  rebindSession(oldSessionId: string, newSessionId: string): void;
  updateOptions(preferences: TerminalDisplayPreferences): void;
  dispose(sessionId: string): void;
  disposeAll(): void;
  subscribe(listener: () => void): () => void;
}

export const terminalRegistry: TerminalRegistry = (() => {
  const controllers = new Map<string, TerminalController>();
  const listeners = new Set<() => void>();
  let preferences = DEFAULT_TERMINAL_PREFERENCES;

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    create(sessionId, setStatus, setClosed, getStatus, requestReconnect) {
      const existing = controllers.get(sessionId);
      if (existing) {
        existing.dispose();
      }
      const controller = new TerminalControllerImpl(
        sessionId,
        setStatus,
        setClosed,
        getStatus,
        requestReconnect,
        (currentSessionId) => {
          controllers.delete(currentSessionId);
          notify();
        },
        preferences,
      );
      controllers.set(sessionId, controller);
      notify();
      return controller;
    },
    get(sessionId) {
      return controllers.get(sessionId);
    },
    rebindSession(oldSessionId, newSessionId) {
      if (oldSessionId === newSessionId) return;
      const controller = controllers.get(oldSessionId);
      if (!controller) return;
      controllers.get(newSessionId)?.dispose();
      controllers.delete(oldSessionId);
      controller.rebindSession(newSessionId);
      controllers.set(newSessionId, controller);
      notify();
    },
    updateOptions(nextPreferences) {
      preferences = nextPreferences;
      for (const controller of controllers.values()) {
        controller.updateOptions(preferences);
      }
    },
    dispose(sessionId) {
      const controller = controllers.get(sessionId);
      if (!controller) return;
      controller.dispose();
      controllers.delete(sessionId);
      notify();
    },
    disposeAll() {
      for (const controller of controllers.values()) {
        controller.dispose();
      }
      controllers.clear();
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
})();
