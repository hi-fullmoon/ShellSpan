import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import {
  invokeGetSessionStatus,
  invokeMarkSessionReady,
  invokeSetSessionOutputPaused,
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
import {
  appendTerminalOutput,
  clearTerminalOutput,
  rebindTerminalOutput,
} from '@/lib/terminal-output-buffer';
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
const OUTPUT_PAUSE_HIGH_WATERMARK = 512 * 1024;
const OUTPUT_RESUME_LOW_WATERMARK = 128 * 1024;
const OUTPUT_RESUME_RETRY_BASE_MS = 250;
const OUTPUT_RESUME_RETRY_MAX_MS = 2000;

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

type TerminalTheme = NonNullable<ConstructorParameters<typeof Terminal>[0]>['theme'];

const TERMINAL_COLOR_THEMES: Record<Exclude<TerminalColorScheme, 'app'>, TerminalTheme> = {
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
  dracula: {
    background: '#282a36',
    foreground: '#e5e5df',
    cursor: '#e5e5df',
    selectionBackground: '#44475a',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
  },
  nord: {
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    selectionBackground: '#434c5e',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
  gruvboxDark: {
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#ebdbb2',
    selectionBackground: '#504945',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2',
  },
  tokyoNight: {
    background: '#1a1b26',
    foreground: '#c0caf5',
    cursor: '#c0caf5',
    selectionBackground: '#33467c',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  },
  catppuccinMocha: {
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    selectionBackground: '#45475a',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
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

function readAppColor(variable: string, lightFallback: string, darkFallback: string): string {
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (resolved) return resolved;
  return document.documentElement.dataset.theme === 'dark' ? darkFallback : lightFallback;
}

export function resolveTerminalTheme(colorScheme: TerminalColorScheme): TerminalTheme {
  if (colorScheme !== 'app') return TERMINAL_COLOR_THEMES[colorScheme];
  return {
    background: readAppColor('--app-surface', '#ffffff', '#202122'),
    foreground: readAppColor('--app-text', '#0f172a', '#d4d4d8'),
    cursor: readAppColor('--app-primary', '#0e7490', '#b3b3b8'),
    selectionBackground: readAppColor(
      '--app-terminal-selection',
      'rgba(14, 116, 144, 0.28)',
      'rgba(244, 244, 245, 0.22)',
    ),
    selectionInactiveBackground: readAppColor(
      '--app-terminal-selection-inactive',
      'rgba(14, 116, 144, 0.16)',
      'rgba(244, 244, 245, 0.12)',
    ),
  };
}

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
  refreshTheme(): void;
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
  private webglAddon?: WebglAddon;
  private webglContextLossDisposable?: IDisposable;
  private pendingOutputCharacters = 0;
  private outputPaused = false;
  private outputGeneration = 0;
  private outputPauseCommand: Promise<void> = Promise.resolve();
  private outputResumeRetryTimer: number | null = null;
  private outputResumeRetryAttempts = 0;

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
      theme: resolveTerminalTheme(preferences.colorScheme),
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
    this.container.className = 'h-full w-full [&_.xterm-viewport]:opacity-0 [&>.terminal.xterm]:h-full [&>.terminal.xterm]:p-[4px_0_4px_4px]';

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

  private updateElementStyles(theme = resolveTerminalTheme(this.preferences.colorScheme)): void {
    const element = this.terminal.element;
    if (!element) return;

    element.style.width = '100%';
    element.style.height = '100%';

    const background = theme?.background;
    const viewport = element.querySelector<HTMLElement>('.xterm-viewport');
    if (background) {
      element.style.setProperty('background-color', background, 'important');
      viewport?.style.setProperty('background-color', background, 'important');
    } else {
      element.style.removeProperty('background-color');
      viewport?.style.removeProperty('background-color');
    }
  }

  // Renderer addons need the terminal element, so WebGL is attempted once
  // after the first successful open(). Keeping the attempt controller-scoped
  // prevents detach/reattach and reconnect from accumulating addons.
  private setupRenderer(): void {
    if (this.rendererInitialized) return;
    this.rendererInitialized = true;

    try {
      const addon = new WebglAddon();
      this.webglAddon = addon;
      this.webglContextLossDisposable = addon.onContextLoss(() => {
        if (this.disposed || this.webglAddon !== addon) return;
        logger.warn(`WebGL context lost for session ${this.sessionId}; falling back to DOM renderer`);
        this.disposeWebglRenderer(addon);
      });
      this.terminal.loadAddon(addon);
      this.setRendererMode('webgl');
    } catch (error) {
      // loadAddon wraps dispose before calling activate, so disposing here
      // also removes a partially activated addon from xterm's addon manager.
      this.disposeWebglRenderer();
      this.setRendererMode('dom');
      logger.warn(`WebGL renderer unavailable for session ${this.sessionId}; using DOM renderer`, error);
    }
  }

  private setRendererMode(mode: RendererMode): void {
    this.rendererMode = mode;
    this.container.classList.toggle(VIEWPORT_HIDDEN_CLASS, mode === 'dom');
  }

  private disposeWebglRenderer(expectedAddon?: WebglAddon): void {
    const addon = this.webglAddon;
    if (!addon || (expectedAddon && addon !== expectedAddon)) return;

    this.webglAddon = undefined;
    this.webglContextLossDisposable?.dispose();
    this.webglContextLossDisposable = undefined;
    try {
      addon.dispose();
    } catch (error) {
      logger.warn(`Failed to dispose WebGL renderer for session ${this.sessionId}`, error);
    }
    this.setRendererMode('dom');
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
      appendTerminalOutput(sessionId, event.payload);
      this.writeSessionOutput(event.payload);
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
        const reconnectSessionId = this.sessionId;
        window.setTimeout(() => {
          if (this.disposed || this.sessionId !== reconnectSessionId) return;
          this.writeSystemLine(formatTerminalNoticeLine(t('terminal.notice.reconnectingLabel'), t('terminal.notice.reconnectingMessage'), '36'));
          Promise.resolve(this.requestReconnect(reconnectSessionId)).finally(() => {
            if (this.disposed || this.sessionId !== reconnectSessionId) return;
            this.reconnectRequestedRef = false;
          });
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

  private writeSessionOutput(chunk: string): void {
    const generation = this.outputGeneration;
    const length = chunk.length;
    this.pendingOutputCharacters += length;
    if (
      !this.outputPaused
      && this.pendingOutputCharacters >= OUTPUT_PAUSE_HIGH_WATERMARK
    ) {
      this.setOutputPaused(true);
    }
    this.terminal.write(chunk, () => {
      if (this.disposed || generation !== this.outputGeneration) return;
      this.pendingOutputCharacters = Math.max(0, this.pendingOutputCharacters - length);
      if (
        this.outputPaused
        && this.pendingOutputCharacters <= OUTPUT_RESUME_LOW_WATERMARK
      ) {
        this.setOutputPaused(false);
      }
    });
  }

  private setOutputPaused(paused: boolean, force = false): void {
    if (this.outputPaused === paused && !force) return;
    this.outputPaused = paused;
    if (paused) {
      this.cancelOutputResumeRetry();
    }
    const sessionId = this.sessionId;
    const command = this.outputPauseCommand.then(() =>
      invokeSetSessionOutputPaused(sessionId, paused),
    );
    this.outputPauseCommand = command.then(() => {
      if (!paused && !this.disposed && this.sessionId === sessionId && !this.outputPaused) {
        this.outputResumeRetryAttempts = 0;
        this.cancelOutputResumeRetry();
      }
    }, (error) => {
      const isCurrentSession = !this.disposed && this.sessionId === sessionId;
      if (paused && isCurrentSession && this.outputPaused) {
        this.outputPaused = false;
      } else if (
        !paused
        && isCurrentSession
        && !this.outputPaused
        && this.getStatus(sessionId) === 'connected'
      ) {
        this.scheduleOutputResumeRetry(sessionId);
      }
      logger.warn(
        `Failed to ${paused ? 'pause' : 'resume'} session output ${sessionId}`,
        error,
      );
    });
  }

  private scheduleOutputResumeRetry(sessionId: string): void {
    if (this.outputResumeRetryTimer !== null) return;
    const delay = Math.min(
      OUTPUT_RESUME_RETRY_BASE_MS * 2 ** this.outputResumeRetryAttempts,
      OUTPUT_RESUME_RETRY_MAX_MS,
    );
    this.outputResumeRetryAttempts += 1;
    this.outputResumeRetryTimer = window.setTimeout(() => {
      this.outputResumeRetryTimer = null;
      if (
        this.disposed
        || this.sessionId !== sessionId
        || this.outputPaused
        || this.getStatus(sessionId) !== 'connected'
      ) {
        return;
      }
      this.setOutputPaused(false, true);
    }, delay);
  }

  private cancelOutputResumeRetry(): void {
    if (this.outputResumeRetryTimer !== null) {
      window.clearTimeout(this.outputResumeRetryTimer);
      this.outputResumeRetryTimer = null;
    }
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
    const previousSessionId = this.sessionId;
    this.clearListeners();
    this.cancelPendingResize();
    this.cancelOutputResumeRetry();
    this.outputResumeRetryAttempts = 0;
    if (this.outputPaused) {
      this.setOutputPaused(false);
    }
    this.pendingOutputCharacters = 0;
    this.outputGeneration += 1;
    this.sessionId = sessionId;
    rebindTerminalOutput(previousSessionId, sessionId);
    this.resetNoticeState();
    this.inputGraceDeadlineRef = Date.now() + RECONNECT_INPUT_GRACE_MS;
    void this.setupListeners();
  }

  updateOptions(preferences: TerminalDisplayPreferences): void {
    if (this.disposed) return;
    const previous = this.preferences;
    this.preferences = preferences;
    const geometryChanged =
      previous.fontSize !== preferences.fontSize
      || previous.fontFamily !== preferences.fontFamily
      || previous.lineHeight !== preferences.lineHeight
      || previous.letterSpacing !== preferences.letterSpacing;

    if (previous.fontSize !== preferences.fontSize) {
      this.terminal.options.fontSize = preferences.fontSize;
    }
    if (previous.fontFamily !== preferences.fontFamily) {
      this.terminal.options.fontFamily = TERMINAL_FONT_FAMILIES[preferences.fontFamily];
    }
    if (previous.cursorBlink !== preferences.cursorBlink) {
      this.terminal.options.cursorBlink = preferences.cursorBlink;
    }
    if (previous.cursorStyle !== preferences.cursorStyle) {
      this.terminal.options.cursorStyle = preferences.cursorStyle;
    }
    if (previous.scrollback !== preferences.scrollback) {
      this.terminal.options.scrollback = preferences.scrollback;
    }
    if (previous.colorScheme !== preferences.colorScheme) {
      const theme = resolveTerminalTheme(preferences.colorScheme);
      this.terminal.options.theme = theme;
      this.updateElementStyles(theme);
    }
    if (previous.lineHeight !== preferences.lineHeight) {
      this.terminal.options.lineHeight = preferences.lineHeight;
    }
    if (previous.letterSpacing !== preferences.letterSpacing) {
      this.terminal.options.letterSpacing = preferences.letterSpacing;
    }
    if (previous.urlDetection !== preferences.urlDetection) {
      this.updateLinkProvider();
    }
    if (geometryChanged && this.host) {
      try {
        this.fitAddon.fit();
      } catch {
        // The host can briefly be unmeasurable while switching sections.
      }
    }
  }

  refreshTheme(): void {
    if (this.disposed || this.preferences.colorScheme !== 'app') return;
    const theme = resolveTerminalTheme('app');
    this.terminal.options.theme = theme;
    this.updateElementStyles(theme);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    logger.debug(`Terminal disposed for session ${this.sessionId}`);
    this.cancelOutputResumeRetry();
    if (this.outputPaused) {
      this.setOutputPaused(false);
    }
    this.detach();
    this.clearListeners();
    this.linkProviderDisposable?.dispose();
    this.disposeWebglRenderer();
    this.terminal.dispose();
    clearTerminalOutput(this.sessionId);
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
  refreshTheme(): void;
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
    refreshTheme() {
      for (const controller of controllers.values()) {
        controller.refreshTheme();
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
