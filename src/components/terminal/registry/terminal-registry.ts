import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { terminalFontStack } from '@/lib/terminal/terminal-font';
import { decodeTerminalClipboardWrite } from '@/lib/terminal/terminal-osc52';
import { findFileLinksInLine, findHttpLinksInLine, findLinksInTerminalBuffer, openTerminalFileLink, shouldActivateTerminalLink, terminalHttpUrl } from '@/lib/terminal/terminal-links';
import { writeClipboardText } from '@/lib/clipboard';
import { useAppStore } from '@/stores/appStore';
import { getTerminalBroadcastTargets } from '@/stores/terminalBroadcastStore';
import { createTerminalResizeHandler, installTerminalScrollbarVisibility, measureTerminalGeometry, TERMINAL_CONTAINER_CLASS } from './terminal-geometry';
import { installTerminalEdgeBackground } from './terminal-edge-background';
import { installTerminalCommandDecorations } from './terminal-command-decorations';
import { attachNativeInputDisplay, type NativeInputDisplayController } from '@/lib/terminal/native-input-display';
import { attachRawInputDisplay } from '@/lib/terminal/raw-input-display';
import { observeNativePromptOrigin } from '@/lib/terminal/native-prompt-origin';
import { terminalInputReadiness } from '../terminal-input-readiness';
import { TerminalSearchAddon } from '../terminal-search-addon';
import { useToastStore } from '@/stores/toastStore';
import {
  invokeGetSessionStatus,
  invokeGetTerminalDisplaySnapshot,
  invokeMarkSessionReady,
  invokeSetSessionOutputPaused,
  invokeResizeSession,
  invokeWriteSession,
  invokeWriteSessionBytes,
  invokeOpenUrl,
  listenToSshClosed,
  listenToSshData,
  listenToSshStatus,
  listenToTerminalDisplay,
  listenToTerminalPromptOrigin,
  invokeRespondTerminalPromptOrigin,
  type TerminalPromptOriginRequest,
} from '@/lib/ipc/tauri';
import { formatTerminalNoticeLine, formatTerminalStatusLine, shouldDisableTerminalInput, shouldReconnectFromInput } from '@/lib/terminal/terminal';
import { t } from '@/locales';
import { createLogger } from '@/lib/logger';
import {
  appendTerminalOutput,
  clearTerminalOutput,
  rebindTerminalOutput,
} from '@/lib/terminal/terminal-output-buffer';
import type {
  ClosedEvent,
  SessionStatus,
  SessionPtyInfo,
  StatusEvent,
  TerminalBellStyle,
  TerminalColorScheme,
  TerminalCursorStyle,
  TerminalFontFamily,
} from '@/types';
import type { IDisposable, ILink } from '@xterm/xterm';
import { useTerminalStore } from '@/stores/terminalStore';
import type { TerminalDisplayBinding } from '@/types/agent-session';
import { restoreTerminalDisplay } from '@/lib/terminal/terminal-display-restore';
import type { TerminalColorOverrides } from '@/lib/terminal/terminal-colors';
import { playBellSound, resolveTerminalTheme } from './terminal-themes';
import { applyTrackedUserInput, hasKnownCredentialPrompt as detectKnownCredentialPrompt } from './terminal-input-heuristics';

export { resolveTerminalTheme };

const logger = createLogger('terminal');

export { findHttpLinksInBuffer, findHttpLinksInLine } from '@/lib/terminal/terminal-links';

function resolveWindowsPty(ptyInfo?: SessionPtyInfo): { backend: 'conpty'; buildNumber?: number } | undefined {
  if (ptyInfo?.transportKind !== 'windowsConPty') return undefined;
  const build = ptyInfo.windowsBuildNumber;
  return Number.isSafeInteger(build) && (build ?? 0) > 0
    ? { backend: 'conpty', buildNumber: build }
    : { backend: 'conpty' };
}

const BRACKETED_PASTE_CONTROL_PATTERN = /(?:\u001b\[|\u009b)20[01]~/g;
const OSC52_RATE_WINDOW_MS = 2000;
const OSC52_MAX_WRITES_PER_WINDOW = 4;

export function sanitizeBracketedPasteText(text: string): string {
  return text.replace(BRACKETED_PASTE_CONTROL_PATTERN, '');
}

function formatTerminalPasteData(terminal: Terminal, text: string): string {
  const normalized = sanitizeBracketedPasteText(text).replace(/\r?\n/g, '\r');
  if (terminal.modes?.bracketedPasteMode && !terminal.options?.ignoreBracketedPasteMode) {
    return `\u001b[200~${normalized}\u001b[201~`;
  }
  return normalized;
}

export type StatusCallback = (sessionId: string, payload: StatusEvent) => void;
export type ClosedCallback = (sessionId: string, payload: ClosedEvent) => void;
export type GetStatusCallback = (sessionId: string) => SessionStatus;
export type RequestReconnectCallback = (sessionId: string, automatic?: boolean) => void;
export type TerminalOutputCallback = (chunk: string) => void;
/** Actual bytes sent to the display; does not grant PTY input or execution authority. */
export type TerminalDisplayOutput = Readonly<{source: 'session' | 'local'; data: string}>;
export type TerminalDisplayOutputCallback = (output: TerminalDisplayOutput) => void;
export interface TerminalOutputFilter {
  push(chunk: string): string;
  finish(): string;
}
export type TerminalLifecycleEvent =
  | Readonly<{ type: 'status'; sessionId: string; payload: StatusEvent }>
  | Readonly<{ type: 'closed'; sessionId: string; payload: ClosedEvent }>
  | Readonly<{ type: 'rebound'; sessionId: string; newSessionId: string }>
  | Readonly<{ type: 'disposed'; sessionId: string }>;
export type TerminalLifecycleCallback = (event: TerminalLifecycleEvent) => void;

export interface TerminalDisplayPreferences {
  fontSize: number;
  fontFamily: TerminalFontFamily;
  customFontFamily?: string;
  macOptionIsMeta?: boolean;
  altClickMovesCursor?: boolean;
  webglRenderer?: boolean;
  cursorBlink: boolean;
  cursorStyle: TerminalCursorStyle;
  scrollback: number;
  colorScheme: TerminalColorScheme;
  colorOverrides?: TerminalColorOverrides;
  autoReconnect: boolean;
  lineHeight: number;
  letterSpacing: number;
  urlDetection: boolean;
  bellStyle: TerminalBellStyle;
}

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

const RESIZE_RETRY_BASE_MS = 250;
const RESIZE_RETRY_MAX_MS = 2000;
const OUTPUT_PAUSE_HIGH_WATERMARK = 512 * 1024;
const OUTPUT_RESUME_LOW_WATERMARK = 128 * 1024;
const OUTPUT_RESUME_RETRY_BASE_MS = 250;
const OUTPUT_RESUME_RETRY_MAX_MS = 2000;

export interface RebindSessionOptions {
  /** Clear screen, scrollback, and buffered output so the rebound session starts fresh. */
  resetBuffer?: boolean;
}

export interface TerminalController {
  readonly inputMode: 'native-inline' | 'raw';
  sessionId: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: TerminalSearchAddon;
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
  fit(): void;
  focus(): void;
  simulateInput(data: string): void;
  hasPendingUserInput(): boolean;
  hasUnconfirmedLineBreak(): boolean;
  hasUnverifiedUserSubmission(): boolean;
  hasKnownCredentialPrompt(): boolean;
  suppressUserInput(onBlocked?: () => void, shouldBlock?: () => boolean): () => void;
  writeUserInput(data: string, broadcast?: boolean): Promise<boolean>;
  writeUserBinaryInput(data: Uint8Array): Promise<boolean>;
  pasteUserText(text: string, broadcast?: boolean): void;
  writeInput(data: string): Promise<void>;
  whenOutputReady(): Promise<void>;
  restoreDisplay(binding: TerminalDisplayBinding): void;
  subscribeOutput(listener: TerminalOutputCallback): () => void;
  subscribeDisplayOutput(listener: TerminalDisplayOutputCallback): () => void;
  /** Read-only notification from the actual public xterm write callback. */
  subscribeDisplayOutputParsed(listener: TerminalDisplayOutputCallback): () => void;
  subscribeOutputFilter(filter: TerminalOutputFilter): () => void;
  subscribeLifecycle(listener: TerminalLifecycleCallback): () => void;
  write(chunk: string): void;
  writeDisconnectedHint(): void;
  writeConnectionFailure(message: string): void;
  clearConnectionFailure(): void;
  rebindSession(sessionId: string, ptyInfo?: SessionPtyInfo, options?: RebindSessionOptions): void;
  updateOptions(preferences: TerminalDisplayPreferences): void;
  refreshTheme(): void;
  dispose(): void;
}

class TerminalControllerImpl implements TerminalController {
  private keyboardBroadcastData?: string;
  private compositionActive = false;
  private compositionDraft = '';
  private compositionBroadcastText?: { data: string; until: number };
  private imeKey229Until = 0;
  inputMode: TerminalController['inputMode'] = 'raw';
  private nativeDisplay?: NativeInputDisplayController;
  private rawDisplay?: IDisposable;
  private originEligible = false;
  private originUnlisten?: () => void;
  private readonly originPending = new Set<string>();
  private originTail: Promise<void> = Promise.resolve();
  private readonly removeFromRegistry: (sessionId: string) => void;
  sessionId: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: TerminalSearchAddon;
  container: HTMLDivElement;
  host: HTMLElement | null = null;
  resizeObserver: ResizeObserver | null = null;
  unlisten: TerminalController['unlisten'];
  private opened = false;
  private disposed = false;
  private webglAddon?: IDisposable;
  private webglLoadToken = 0;
  private readonly setStatus: StatusCallback;
  private readonly setClosed: ClosedCallback;
  private readonly getStatus: GetStatusCallback;
  private readonly requestReconnect: RequestReconnectCallback;
  private inputBlockedNoticeRef = false;
  private readonly userInputSuppressions = new Set<{ onBlocked?: () => void; shouldBlock?: () => boolean }>();
  private agentInputBlockedFeedbackRef = false;
  private pendingUserInputText = '';
  private submittedContinuationText = '';
  private lastInputLineBreak: { terminalSessionId?: string; generation?: number; revision?: number } | null = null;
  private unverifiedUserSubmission = false;
  private recentOutputTail = '';
  private reconnectRequestedRef = false;
  private listenerGeneration = 0;
  private restoringDisplay = false;
  private readonly osc52WriteTimestamps: number[] = [];
  private preferences: TerminalDisplayPreferences;
  private linkProviderDisposable?: IDisposable;
  private resizeHandler?: ReturnType<typeof createTerminalResizeHandler>;
  // Last size acknowledged by the pty resize command. The backend relays every resize as an
  // SSH window-change even when the size is unchanged, and the resulting
  // SIGWINCH makes the remote shell redraw its prompt — sometimes leaving
  // duplicated/garbled prompt lines — so identical resizes are dropped here.
  private lastSentDimensions: { cols: number; rows: number } | null = null;
  private sendingDimensions: { cols: number; rows: number } | null = null;
  private queuedResizeDimensions: { cols: number; rows: number } | null = null;
  private resizeRetryTimer: number | null = null;
  private resizeRetryAttempts = 0;
  private edgeBackground?: IDisposable;
  private commandDecorations: ReturnType<typeof installTerminalCommandDecorations>;
  private scrollbarVisibility?: IDisposable;
  private pendingOutputCharacters = 0;
  private outputPaused = false;
  private outputGeneration = 0;
  private outputPauseCommand: Promise<void> = Promise.resolve();
  private outputResumeRetryTimer: number | null = null;
  private outputResumeRetryAttempts = 0;
  private readonly outputListeners = new Set<TerminalOutputCallback>();
  private readonly displayOutputListeners = new Set<TerminalDisplayOutputCallback>();
  private readonly displayOutputParsedListeners = new Set<TerminalDisplayOutputCallback>();
  private readonly outputFilters = new Set<TerminalOutputFilter>();
  private readonly lifecycleListeners = new Set<TerminalLifecycleCallback>();
  private listenerSetup: Promise<void>;

  constructor(
    sessionId: string,
    setStatus: StatusCallback,
    setClosed: ClosedCallback,
    getStatus: GetStatusCallback,
    requestReconnect: RequestReconnectCallback,
    removeFromRegistry: (sessionId: string) => void,
    preferences: TerminalDisplayPreferences,
    ptyInfo?: SessionPtyInfo,
  ) {
    this.sessionId = sessionId;
    this.setStatus = setStatus;
    this.setClosed = setClosed;
    this.getStatus = getStatus;
    this.requestReconnect = requestReconnect;
    this.removeFromRegistry = removeFromRegistry;
    this.preferences = preferences;

    this.terminal = new Terminal({
      // Search result counts and match highlights use xterm's decoration API.
      allowProposedApi: true,
      fontFamily: terminalFontStack(preferences.fontFamily, preferences.customFontFamily),
      macOptionIsMeta: preferences.macOptionIsMeta ?? false,
      altClickMovesCursor: preferences.altClickMovesCursor ?? true,
      linkHandler: {
        allowNonHttpProtocols: false,
        activate: (event, text) => {
          if (shouldActivateTerminalLink(event)) this.activateUrl(text);
        },
      },
      fontSize: preferences.fontSize,
      theme: resolveTerminalTheme(preferences.colorScheme, preferences.colorOverrides),
      cursorBlink: preferences.cursorBlink,
      rightClickSelectsWord: false,
      cursorStyle: preferences.cursorStyle,
      scrollback: preferences.scrollback,
      overviewRuler: { width: 10 },
      lineHeight: preferences.lineHeight,
      letterSpacing: preferences.letterSpacing,
      windowsPty: resolveWindowsPty(ptyInfo),
    });
    this.fitAddon = new FitAddon();
    this.searchAddon = new TerminalSearchAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);
    this.commandDecorations = this.installInputRendering(ptyInfo);

    this.container = document.createElement('div');
    this.container.className = TERMINAL_CONTAINER_CLASS;
    this.container.addEventListener('input', (event) => {
      const input = event as InputEvent;
      if (input.isTrusted && input.target === this.terminal.textarea && input.data
        && (input.inputType === 'insertText' || input.inputType === 'insertReplacementText')) {
        const value = input.data;
        this.keyboardBroadcastData = value;
        queueMicrotask(() => {
          if (this.keyboardBroadcastData === value) this.keyboardBroadcastData = undefined;
        });
      }
    }, true);
    this.container.addEventListener('compositionstart', (event) => {
      if (event.isTrusted && event.target === this.terminal.textarea) {
        this.compositionActive = true;
        this.compositionDraft = '';
      }
    }, true);
    this.container.addEventListener('compositionupdate', (event) => {
      if (event.isTrusted && event.target === this.terminal.textarea) {
        this.compositionDraft = event.data ?? '';
      }
    }, true);
    this.container.addEventListener('keydown', (event) => {
      if (!event.isTrusted || event.target !== this.terminal.textarea) return;
      if (event.keyCode === 229) {
        this.imeKey229Until = performance.now() + 500;
      } else if (this.compositionActive && event.keyCode !== 20 && event.keyCode !== 16
        && event.keyCode !== 17 && event.keyCode !== 18) {
        if (this.compositionDraft && !/[\u0000-\u001f\u007f]/.test(this.compositionDraft)) {
          this.compositionBroadcastText = { data: this.compositionDraft, until: performance.now() + 500 };
        }
      }
    }, true);
    this.container.addEventListener('compositionend', (event) => {
      if (event.isTrusted && event.target === this.terminal.textarea) {
        this.compositionActive = false;
        this.compositionDraft = '';
        if (event.data && !/[\u0000-\u001f\u007f]/.test(event.data)) {
          this.compositionBroadcastText = { data: event.data, until: performance.now() + 500 };
        }
      }
    }, true);

    this.unlisten = {
      data: undefined,
      status: undefined,
      closed: undefined,
    };

    this.terminal.onKey(({ key, domEvent }) => {
      if (!domEvent.isTrusted) return;
      this.keyboardBroadcastData = key;
      queueMicrotask(() => {
        if (this.keyboardBroadcastData === key) this.keyboardBroadcastData = undefined;
      });
    });
    this.terminal.onData((data) => this.handleInput(data, this.takeBroadcastOrigin(data)));
    this.terminal.onBinary((data) => this.handleBinaryInput(data, false));
    this.terminal.onBell(() => {
      if (this.preferences.bellStyle === 'sound') playBellSound();
    });
    this.terminal.onTitleChange((title) => useTerminalStore.getState().setOscTitle(this.sessionId, title));
    this.terminal.parser.registerOscHandler(52, (payload) => {
      if (this.restoringDisplay || this.getStatus(this.sessionId) !== 'connected') return true;
      if (!this.canWriteOsc52Clipboard()) return true;
      const text = decodeTerminalClipboardWrite(payload, useAppStore.getState().terminalOsc52Policy);
      if (text !== null) void writeClipboardText(text).catch(() => {
        useToastStore.getState().addToast(t('terminal.feedback.copyFailed'), 'error');
      });
      return true;
    });
    this.updateLinkProvider();

    this.listenerSetup = this.startListenerSetup(
      ptyInfo?.transportKind === 'windowsConPty' && ptyInfo.deferredStartup === true,
    );
  }

  private startListenerSetup(resizeBeforeReady = false, restore?: TerminalDisplayBinding): Promise<void> {
    const setup = this.setupListeners(resizeBeforeReady, restore);
    void setup.catch((error) => {
      logger.warn(`Failed to install terminal listeners for session ${this.sessionId}`, error);
    });
    return setup;
  }

  restoreDisplay(binding: TerminalDisplayBinding): void {
    if (this.disposed) return;
    this.restoringDisplay = true;
    this.clearListeners();
    this.listenerSetup = this.startListenerSetup(false, binding);
  }

  private installInputRendering(ptyInfo?: SessionPtyInfo): ReturnType<typeof installTerminalCommandDecorations> {
    this.originEligible = ptyInfo?.transportKind === 'windowsConPty' && ptyInfo.inputMode === 'native-inline'
      && ptyInfo.nativeDisplayBinding?.unicodeVersion === '15-graphemes'
      && ptyInfo.nativeDisplayBinding.unicodeScope === 'session'
      && ptyInfo.nativeDisplayBinding.ownedReflowCursorLine === false;
    this.inputMode = ptyInfo?.inputMode ?? 'raw';
    this.rawDisplay = attachRawInputDisplay(this.terminal, ptyInfo);
    if (this.inputMode === 'native-inline' && ptyInfo?.nativeDisplayBinding) {
      const unicodeVersion = ptyInfo.nativeDisplayBinding.unicodeVersion;
      if (unicodeVersion === '11' && !this.terminal.unicode.versions.includes('11')) {
        this.terminal.loadAddon(new Unicode11Addon());
      }
      if (unicodeVersion === '15-graphemes' && !this.terminal.unicode.versions.includes(unicodeVersion)) {
        const previous = this.terminal.unicode.activeVersion;
        this.terminal.loadAddon(new UnicodeGraphemesAddon());
        // Registration activates this addon; the negotiated display owns scope.
        this.terminal.unicode.activeVersion = previous;
      }
      this.nativeDisplay = attachNativeInputDisplay(this.terminal, ptyInfo.nativeDisplayBinding, {
        unicodeVersion, unicodeScope: ptyInfo.nativeDisplayBinding.unicodeScope,
      });
    }
    // Every mode renders only PTY bytes. Decorations never receive source text.
    return this.inputMode === 'raw'
      ? { dispose() {}, rebind() {} }
      : installTerminalCommandDecorations(this.terminal, this.sessionId, ptyInfo?.nativeDisplayBinding);
  }

  private async closeInputRendering(): Promise<void> {
    const display = this.nativeDisplay;
    const rawDisplay = this.rawDisplay;
    this.nativeDisplay = undefined;
    if (display) await display.closeAfterPendingOutput();
    else await new Promise<void>(resolve => this.terminal.write('', resolve));
    rawDisplay?.dispose();
    if (this.rawDisplay === rawDisplay) this.rawDisplay = undefined;
  }

  private handleInput(data: string, broadcast = false): void {
    const status = this.getStatus(this.sessionId);

    if (status === 'connected') {
      void this.writeUserInput(data, broadcast).catch((error) => {
        logger.error(`Failed to write input to session ${this.sessionId}`, error);
        this.showWriteFailure();
      });
      return;
    }
    if (this.isReadOnly()) return;

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

  private clearBroadcastOrigin(): void {
    this.keyboardBroadcastData = undefined;
    this.compositionBroadcastText = undefined;
    this.imeKey229Until = 0;
  }

  private takeBroadcastOrigin(data: string): boolean {
    if (this.keyboardBroadcastData === data) {
      this.keyboardBroadcastData = undefined;
      return true;
    }
    this.keyboardBroadcastData = undefined;

    const now = performance.now();
    const isSafeText = data.length > 0 && !/[\u0000-\u001f\u007f]/.test(data);
    const composition = this.compositionBroadcastText;
    if (composition) {
      if (composition.until < now) {
        this.compositionBroadcastText = undefined;
      } else if (composition.data === data || (isSafeText && composition.data.endsWith(data))) {
        this.compositionBroadcastText = undefined;
        this.imeKey229Until = 0;
        return true;
      }
    }

    if (this.imeKey229Until > 0) {
      if (this.imeKey229Until < now) {
        this.imeKey229Until = 0;
      } else if (isSafeText || data === '\u007f') {
        this.imeKey229Until = 0;
        return true;
      }
    }

    return false;
  }

  private handleBinaryInput(data: string, broadcast: boolean): void {
    if (this.getStatus(this.sessionId) !== 'connected') return;
    const bytes = Uint8Array.from(data, (character) => character.charCodeAt(0) & 0xff);
    void this.writeUserBinaryInput(bytes, broadcast).catch((error) => {
      logger.error(`Failed to write binary input to session ${this.sessionId}`, error);
      this.showWriteFailure();
    });
  }

  private updateElementStyles(theme = resolveTerminalTheme(this.preferences.colorScheme, this.preferences.colorOverrides)): void {
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

  private writeSystemLine(line: string): void {
    if (this.disposed) return;
    this.emitDisplayOutput(line + '\r\n', 'local');
    this.terminal.writeln(line, this.displayOutputParsedCallback(line + '\r\n', 'local'));
  }

  private emitDisplayOutput(data: string, source: TerminalDisplayOutput['source']): void {
    if (this.disposed || !data) return;
    for (const listener of this.displayOutputListeners) {
      try {listener({source, data});}
      catch (error) {logger.warn(`Terminal display output subscriber failed for session ${this.sessionId}`, error);}
    }
  }

  private displayOutputParsedCallback(data: string, source: TerminalDisplayOutput['source']): (() => void) | undefined {
    if (this.disposed || !data || !this.displayOutputParsedListeners.size) return undefined;
    return () => {
      if (this.disposed) return;
      for (const listener of this.displayOutputParsedListeners) {
        try {listener({source, data});}
        catch (error) {logger.warn(`Terminal parsed display subscriber failed for session ${this.sessionId}`, error);}
      }
    };
  }

  private showWriteFailure(): void {
    const message = t('terminal.notice.writeFailedMessage');
    const store = useToastStore.getState();
    if (!store.toasts.some(toast => toast.variant === 'error' && toast.message === message)) {
      store.addToast(message, 'error');
    }
  }

  private showBroadcastWriteFailure(): void {
    const message = t('terminal.broadcast.writeFailed');
    const store = useToastStore.getState();
    if (!store.toasts.some((toast) => toast.variant === 'error' && toast.message === message)) {
      store.addToast(message, 'error');
    }
  }

  private canWriteOsc52Clipboard(): boolean {
    if (this.disposed || this.host === null) return false;
    if (useAppStore.getState().activeSection !== 'terminal') return false;
    if (useTerminalStore.getState().activeSessionId !== this.sessionId) return false;
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false;
    const now = Date.now();
    while (this.osc52WriteTimestamps.length > 0 && now - this.osc52WriteTimestamps[0] > OSC52_RATE_WINDOW_MS) {
      this.osc52WriteTimestamps.shift();
    }
    if (this.osc52WriteTimestamps.length >= OSC52_MAX_WRITES_PER_WINDOW) return false;
    this.osc52WriteTimestamps.push(now);
    return true;
  }

  private activateUrl(text: string): void {
    const url = this.preferences.urlDetection ? terminalHttpUrl(text) : null;
    if (url) void invokeOpenUrl(url).catch(() => useToastStore.getState().addToast(t('ai.link.openFailed'), 'error'));
  }

  private updateLinkProvider(): void {
    this.linkProviderDisposable?.dispose();
    this.linkProviderDisposable = undefined;
    if (!this.preferences.urlDetection) return;
    this.linkProviderDisposable = this.terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const links: ILink[] = [];
        for (const detected of findLinksInTerminalBuffer(
          this.terminal.buffer.active,
          bufferLineNumber,
          this.terminal.cols,
          (text) => [...findHttpLinksInLine(text), ...findFileLinksInLine(text)],
        )) {
          links.push({
            text: detected.text,
            range: detected.range,
            decorations: { pointerCursor: true, underline: true },
            activate: (event, text) => {
              if (!shouldActivateTerminalLink(event)) return;
              if (terminalHttpUrl(text)) {
                this.activateUrl(text);
                return;
              }
              const session = useTerminalStore.getState().sessions.find((item) => item.sessionId === this.sessionId);
              if (session) void openTerminalFileLink(session, text).then((opened) => {
                if (!opened) useToastStore.getState().addToast(t('ai.path.revealFailed'), 'error');
              }).catch(() => useToastStore.getState().addToast(t('ai.path.revealFailed'), 'error'));
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

  private applySessionStatus(sessionId: string, payload: StatusEvent): void {
    this.setStatus(sessionId, payload);
    if (payload.status === 'connected') {
      this.resetNoticeState();
    } else if (payload.status === 'error' && payload.message) {
      this.writeConnectionFailure(payload.message);
    } else {
      this.writeSystemLine(formatTerminalStatusLine(payload.status, payload.message));
    }
  }

  private clearListeners(): number {
    this.listenerGeneration += 1;
    this.originUnlisten?.();this.originUnlisten = undefined;this.originPending.clear();this.originTail = Promise.resolve();
    this.unlisten.data?.();
    this.unlisten.status?.();
    this.unlisten.closed?.();
    this.unlisten = { data: undefined, status: undefined, closed: undefined };
    return this.listenerGeneration;
  }

  private async setupListeners(resizeBeforeReady = false, restore?: TerminalDisplayBinding): Promise<void> {
    const generation = this.listenerGeneration;
    const sessionId = this.sessionId;
    const isCurrent = () => !this.disposed && generation === this.listenerGeneration && sessionId === this.sessionId;
    const writeOutput = (text: string) => {
      if (!isCurrent()) return;
      if (text) {
        this.unverifiedUserSubmission = false;
        this.recentOutputTail = `${this.recentOutputTail}${text}`.slice(-4096);
      }
      const displayPayload = this.filterSessionOutput(text);
      for (const listener of this.outputListeners) {
        try {
          listener(text);
        } catch (error) {
          logger.warn(`Terminal output subscriber failed for session ${sessionId}`, error);
        }
      }
      this.writeVisibleSessionOutput(displayPayload);
    };
    let snapshotNeeded = false;
    let recovery: Promise<void> | undefined;
    const MAX_DISPLAY_RECOVERY_ATTEMPTS = 5;
    let recoveryFailed = false;
    const markRestoreFailure = (error: unknown): void => {
      if (!isCurrent() || recoveryFailed) return;
      recoveryFailed = true;
      logger.warn(`Terminal display recovery failed for ${sessionId}`, error);
      this.setStatus(sessionId, { sessionId, status: 'disconnected' });
    };
    const replay = restore && restoreTerminalDisplay(restore, writeOutput, () => {
      if (recoveryFailed) return;
      snapshotNeeded = true;
      if (!this.restoringDisplay) void recoverDisplay().catch(error => markRestoreFailure(error));
    }, {
      onOverflow: () => markRestoreFailure(new Error('Terminal display pending frame buffer overflow')),
    });
    const recoverDisplay = (): Promise<void> => {
      if (recovery) return recovery;
      recovery = (async () => {
        if (!restore || !replay || recoveryFailed) return;
        this.restoringDisplay = true;
        let attempts = 0;
        do {
          if (attempts >= MAX_DISPLAY_RECOVERY_ATTEMPTS) {
            markRestoreFailure(new Error('Terminal display recovery exceeded retry limit'));
            return;
          }
          if (attempts > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, 25 * (2 ** (attempts - 1)))));
            if (!isCurrent() || recoveryFailed) return;
          }
          attempts += 1;
          snapshotNeeded = false;
          const snapshot = await invokeGetTerminalDisplaySnapshot(sessionId, restore);
          if (!isCurrent() || recoveryFailed) return;
          await new Promise<void>((resolve) => this.terminal.write('', resolve));
          if (!isCurrent() || recoveryFailed) return;
          this.terminal.resize(snapshot.columns, snapshot.rows);
          this.terminal.reset();
          clearTerminalOutput(sessionId);
          this.recentOutputTail = '';
          replay.apply(snapshot);
          await new Promise<void>((resolve) => this.terminal.write('', resolve));
        } while (isCurrent() && !recoveryFailed && snapshotNeeded);
        if (isCurrent() && !recoveryFailed && replay.ready()) {
          this.restoringDisplay = false;
          if (this.host) this.fit(true);
        }
      })().finally(() => { recovery = undefined; });
      return recovery;
    };
    const dataUnlisten = await (replay
      ? listenToTerminalDisplay(sessionId, ({ payload }) => { if (isCurrent()) replay.receive(payload); })
      : listenToSshData(sessionId, ({ payload }) => writeOutput(payload)));
    if (this.disposed || generation !== this.listenerGeneration) {
      dataUnlisten();
      return;
    }
    this.unlisten.data = dataUnlisten;

    const statusUnlisten = await listenToSshStatus(sessionId, (event) => {
      if (this.disposed || generation !== this.listenerGeneration || sessionId !== this.sessionId) return;
      logger.info(`Session ${sessionId} status: ${event.payload.status}`);
      this.emitLifecycle({ type: 'status', sessionId, payload: event.payload });
      if (this.restoringDisplay && event.payload.status === 'connected') return;
      this.applySessionStatus(sessionId, event.payload);
    });
    if (this.disposed || generation !== this.listenerGeneration) {
      statusUnlisten();
      return;
    }
    this.unlisten.status = statusUnlisten;

    const closedUnlisten = await listenToSshClosed(sessionId, (event) => {
      if (this.disposed || generation !== this.listenerGeneration || sessionId !== this.sessionId) return;
      logger.info(`Session ${sessionId} closed${event.payload.reason ? `: ${event.payload.reason}` : ''}`);
      this.emitLifecycle({ type: 'closed', sessionId, payload: event.payload });
      this.setClosed(sessionId, event.payload);
      const showClosed = () => {
        if (this.disposed || sessionId !== this.sessionId) return;
        this.writeSystemLine(
        formatTerminalNoticeLine(t('terminal.notice.closedLabel'), event.payload.reason ? `: ${event.payload.reason}` : undefined, '31'),
        );
        if (!this.isReadOnly()) {
          this.writeSystemLine(formatTerminalNoticeLine(t('terminal.notice.hintLabel'), t('terminal.notice.pressEnterReconnect')));
        }
      };
      {
        this.clearListeners();
        void this.closeInputRendering().then(() => {
          if (this.disposed || sessionId !== this.sessionId) return;
          // A standard ST closes only the old stream's partial escape.
          this.emitDisplayOutput('\u001b\\', 'local');
          this.terminal.write('\u001b\\', this.displayOutputParsedCallback('\u001b\\', 'local'));
          showClosed();
        });
      }
      this.inputBlockedNoticeRef = true;
      if (event.payload.retryable && this.preferences.autoReconnect && !this.reconnectRequestedRef) {
        this.reconnectRequestedRef = true;
        const reconnectSessionId = this.sessionId;
        window.setTimeout(() => {
          if (this.disposed || this.sessionId !== reconnectSessionId) return;
          this.writeSystemLine(formatTerminalNoticeLine(t('terminal.notice.reconnectingLabel'), t('terminal.notice.reconnectingMessage'), '36'));
          Promise.resolve(this.requestReconnect(reconnectSessionId, true)).finally(() => {
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

    if (this.originEligible) {
      const originUnlisten = await listenToTerminalPromptOrigin(event => {
        void this.answerPromptOrigin(event.payload, sessionId, generation);
      });
      if (this.disposed || generation !== this.listenerGeneration || sessionId !== this.sessionId) originUnlisten();
      else this.originUnlisten = originUnlisten;
    }

    try {
      if (restore) await recoverDisplay();
      const snapshot = await invokeGetSessionStatus(sessionId);
      if (!this.disposed && generation === this.listenerGeneration && this.getStatus(sessionId) === 'connecting') {
        logger.info(`Session ${sessionId} reconciled status: ${snapshot.status}`);
        this.emitLifecycle({ type: 'status', sessionId, payload: snapshot });
        this.applySessionStatus(sessionId, snapshot);
      }
    } catch (error) {
      if (restore) {
        markRestoreFailure(error);
        throw error;
      }
      if (!this.disposed && generation === this.listenerGeneration) {
        logger.warn(`Failed to reconcile session ${sessionId} status`, error);
      }
    }

    if (resizeBeforeReady) {
      // The existing renderer may keep its size while the replacement PTY was
      // created with a different grid. A ResizeObserver need not fire on rebind.
      // Synchronize before releasing startup cursor queries or shell output.
      let dimensions: { cols: number; rows: number } | null = {
        cols: this.terminal.cols, rows: this.terminal.rows,
      };
      while (dimensions) {
        if (this.sendingDimensions) {
          this.queuedResizeDimensions = dimensions;
          break;
        }
        this.sendingDimensions = dimensions;
        let failed = false;
        try {
          await invokeResizeSession(sessionId, dimensions.cols, dimensions.rows);
        } catch (error) {
          failed = true;
          logger.warn(`Failed to synchronize initial resize for session ${sessionId}`, error);
        } finally {
          if (this.sendingDimensions === dimensions) this.sendingDimensions = null;
        }
        if (this.disposed || generation !== this.listenerGeneration || sessionId !== this.sessionId) return;
        if (failed) {
          this.sendResize(dimensions.cols, dimensions.rows);
          break;
        }
        this.lastSentDimensions = dimensions;
        const queued = this.queuedResizeDimensions;
        this.queuedResizeDimensions = null;
        dimensions = queued && !this.sameDimensions(dimensions, queued) ? queued : null;
      }
    }

    // All listeners are attached; tell the backend it may release any
    // output it buffered while we were subscribing. On Windows this also
    // delivers ConPTY's startup cursor query so the shell can proceed.
    if (restore) {
      if (isCurrent() && this.getStatus(sessionId) === 'connected') this.setOutputPaused(false, true);
      return;
    }
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
    this.emitDisplayOutput(chunk, 'session');
    const parsed = this.displayOutputParsedCallback(chunk, 'session');
    this.terminal.write(chunk, () => {
      parsed?.();
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

  private writeVisibleSessionOutput(chunk: string): void {
    if (!chunk) return;
    appendTerminalOutput(this.sessionId, chunk);
    this.writeSessionOutput(chunk);
  }

  private finishOutputFilter(filter: TerminalOutputFilter): string {
    try {
      return filter.finish();
    } catch (error) {
      logger.warn(`Terminal output filter failed while flushing session ${this.sessionId}`, error);
      return '';
    }
  }

  private filterSessionOutput(chunk: string): string {
    let display = chunk;
    for (const filter of [...this.outputFilters]) {
      try {
        display = filter.push(display);
      } catch (error) {
        logger.warn(`Terminal output filter failed for session ${this.sessionId}`, error);
        this.outputFilters.delete(filter);
        display = `${this.finishOutputFilter(filter)}${display}`;
      }
    }
    return display;
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
    this.host = host;

    if (!this.opened) {
      try {
        // Keep xterm's DOM renderer so grid changes don't clear a WebGL canvas
        // before the next paint during pane resize.
        this.terminal.open(this.container);
        this.opened = true;
      } catch {
        // jsdom: open() may fail when host is detached. xterm buffers
        // writes before open(), so write() still accumulates buffer.
      }
    }

    if (this.opened) {
      this.edgeBackground ??= installTerminalEdgeBackground(this.terminal);
      this.scrollbarVisibility ??= installTerminalScrollbarVisibility(this.terminal);
      this.syncWebglRenderer(Boolean(this.preferences.webglRenderer));
    }

    this.updateElementStyles();

    try {
      this.fitAddon.fit();
    } catch {
      // fit() can fail without a measurable container; harmless.
    }

    if (!this.resizeObserver) {
      this.resizeHandler = createTerminalResizeHandler(
        this.terminal, this.fitAddon, this.container,
        (cols, rows) => this.sendResize(cols, rows),
      );
      this.resizeObserver = new ResizeObserver(this.resizeHandler.schedule);
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
    this.webglLoadToken += 1;
    this.webglAddon?.dispose();
    this.webglAddon = undefined;
    this.container.remove();
    this.host = null;
  }

  // Drop any scheduled resize frame so a disposed or rebound
  // controller never reflows or sends a resize IPC for a stale session.
  private cancelPendingResize(): void {
    this.resizeHandler?.cancel();
  }

  private cancelResizeRetry(): void {
    if (this.resizeRetryTimer !== null) {
      window.clearTimeout(this.resizeRetryTimer);
      this.resizeRetryTimer = null;
    }
  }

  private sameDimensions(
    left: { cols: number; rows: number } | null,
    right: { cols: number; rows: number },
  ): boolean {
    return left?.cols === right.cols && left.rows === right.rows;
  }

  private sendResize(cols: number, rows: number): void {
    const dimensions = { cols, rows };
    if (!this.sendingDimensions && this.sameDimensions(this.lastSentDimensions, dimensions)) {
      this.queuedResizeDimensions = null;
      this.cancelResizeRetry();
      this.resizeRetryAttempts = 0;
      return;
    }
    if (this.sameDimensions(this.queuedResizeDimensions, dimensions)) return;
    if (!this.queuedResizeDimensions && this.sameDimensions(this.sendingDimensions, dimensions)) return;
    this.queuedResizeDimensions = dimensions;
    this.cancelResizeRetry();
    this.flushResizeQueue();
  }

  private flushResizeQueue(): void {
    if (this.disposed || this.sendingDimensions || this.resizeRetryTimer !== null) return;
    const dimensions = this.queuedResizeDimensions;
    if (!dimensions) return;
    if (this.sameDimensions(this.lastSentDimensions, dimensions)) {
      this.queuedResizeDimensions = null;
      this.resizeRetryAttempts = 0;
      return;
    }
    this.queuedResizeDimensions = null;
    this.sendingDimensions = dimensions;
    const sessionId = this.sessionId;
    void invokeResizeSession(sessionId, dimensions.cols, dimensions.rows).then(() => {
      if (this.disposed || this.sessionId !== sessionId) return;
      this.lastSentDimensions = dimensions;
      this.resizeRetryAttempts = 0;
    }).catch((error) => {
      if (!this.disposed && this.sessionId === sessionId && !this.queuedResizeDimensions) {
        this.queuedResizeDimensions = dimensions;
        const delay = Math.min(
          RESIZE_RETRY_BASE_MS * 2 ** this.resizeRetryAttempts,
          RESIZE_RETRY_MAX_MS,
        );
        this.resizeRetryAttempts += 1;
        this.resizeRetryTimer = window.setTimeout(() => {
          this.resizeRetryTimer = null;
          const status = this.getStatus(this.sessionId);
          if (status !== 'connected' && status !== 'connecting') {
            this.queuedResizeDimensions = null;
            this.resizeRetryAttempts = 0;
            return;
          }
          this.flushResizeQueue();
        }, delay);
      }
      logger.warn(`Failed to resize session ${sessionId}`, error);
    }).finally(() => {
      if (this.disposed || this.sessionId !== sessionId) return;
      if (this.sendingDimensions === dimensions) this.sendingDimensions = null;
      if (this.queuedResizeDimensions && this.resizeRetryTimer === null) {
        this.flushResizeQueue();
      }
    });
  }

  fit(forceRefresh = false): void {
    if (this.disposed) return;

    // A restored terminal can be opened while the whole terminal section is
    // hidden. ResizeObserver intentionally ignores that state, so the first
    // section activation must synchronously fit before the user can press
    // Enter to reconnect. Otherwise the delayed resize lands after the new
    // shell has printed its prompt and SIGWINCH can leave duplicated glyphs.
    // Also refresh the rows when a previously hidden terminal becomes visible.
    if (this.host) {
      this.cancelPendingResize();
      const previousCols = this.terminal.cols;
      const previousRows = this.terminal.rows;
      let dimensionsChanged = false;
      try {
        const proposed = this.fitAddon.proposeDimensions();
        if (!proposed || proposed.cols !== previousCols || proposed.rows !== previousRows) {
          this.fitAddon.fit();
          dimensionsChanged = this.terminal.cols !== previousCols || this.terminal.rows !== previousRows;
        }
      } catch {
        // The host can still be unmeasurable during a section transition.
      }
      if (dimensionsChanged) {
        this.sendResize(this.terminal.cols, this.terminal.rows);
      }
      if (forceRefresh || dimensionsChanged) {
        try {
          this.terminal.refresh(0, this.terminal.rows - 1);
        } catch {
          // Ignore redraw failures on a terminal being detached concurrently.
        }
      }
    }
  }

  focus(): void {
    if (this.disposed) return;
    this.fit();
    try {
      this.terminal.focus();
    } catch {
      // Ignore focus failures on disposed or hidden terminals.
    }
  }

  simulateInput(data: string): void {
    this.handleInput(data);
  }

  suppressUserInput(onBlocked?: () => void, shouldBlock?: () => boolean): () => void {
    if (this.disposed) return () => {};
    const suppression = { onBlocked, shouldBlock };
    this.userInputSuppressions.add(suppression);
    return () => {
      this.userInputSuppressions.delete(suppression);
      if (this.userInputSuppressions.size === 0) {
        this.agentInputBlockedFeedbackRef = false;
      }
    };
  }

  hasPendingUserInput(): boolean {
    this.reconcileSubmittedContinuation();
    return this.pendingUserInputText.length > 0 || this.submittedContinuationText.length > 0;
  }

  hasUnconfirmedLineBreak(): boolean {
    if (!this.lastInputLineBreak) return false;
    const session = useTerminalStore.getState().sessions.find(item => item.sessionId === this.sessionId);
    return !session?.promptReady || session.terminalSessionId !== this.lastInputLineBreak.terminalSessionId
      || session.terminalGeneration !== this.lastInputLineBreak.generation
      || session.promptReadyRevision === undefined || this.lastInputLineBreak.revision === undefined
      || session.promptReadyRevision <= this.lastInputLineBreak.revision;
  }

  private reconcileSubmittedContinuation(): void {
    // The shell can finish a command whose edited text differs from the input cache.
    // A fresh prompt retires submitted lines while preserving the current draft.
    if (this.submittedContinuationText && !this.hasUnconfirmedLineBreak()) {
      this.submittedContinuationText = '';
    }
  }

  hasUnverifiedUserSubmission(): boolean {
    return this.unverifiedUserSubmission;
  }

  hasKnownCredentialPrompt(): boolean {
    return detectKnownCredentialPrompt(this.recentOutputTail);
  }

  private trackUserInput(data: string): void {
    const state = {
      pendingUserInputText: this.pendingUserInputText,
      submittedContinuationText: this.submittedContinuationText,
      unverifiedUserSubmission: this.unverifiedUserSubmission,
    };
    applyTrackedUserInput(state, data);
    this.pendingUserInputText = state.pendingUserInputText;
    this.submittedContinuationText = state.submittedContinuationText;
    this.unverifiedUserSubmission = state.unverifiedUserSubmission;
  }

  private isReadOnly(): boolean {
    return useTerminalStore.getState().sessions.some((session) => session.sessionId === this.sessionId && session.readOnly);
  }

  private canWriteUserInput(): boolean {
    if (this.isReadOnly()) return false;
    const blockers = [...this.userInputSuppressions].filter(({ shouldBlock }) => !shouldBlock || shouldBlock());
    if (blockers.length > 0) {
      if (!this.agentInputBlockedFeedbackRef) {
        this.agentInputBlockedFeedbackRef = true;
        for (const { onBlocked } of blockers) onBlocked?.();
      }
      return false;
    }
    this.agentInputBlockedFeedbackRef = false;
    if (this.restoringDisplay || terminalInputReadiness.isPreparing(this.sessionId)) {
      return false;
    }
    return true;
  }

  private async answerPromptOrigin(request: TerminalPromptOriginRequest, sessionId: string, generation: number): Promise<void> {
    const current = () => {
      const session = useTerminalStore.getState().sessions.find(value => value.sessionId === sessionId);
      return !this.disposed && this.originEligible && generation === this.listenerGeneration && sessionId === this.sessionId
        && request.sessionId === sessionId && session?.terminalSessionId === request.terminalSessionId
        && session.terminalGeneration === request.terminalGeneration;
    };
    if (!request || typeof request !== 'object' || !Number.isSafeInteger(request.timeoutMs)
      || request.timeoutMs < 1 || request.timeoutMs > 10_000 || !request.geometry
      || typeof request.requestId !== 'string' || request.requestId.length > 128
      || !current() || this.originPending.has(request.requestId) || this.originPending.size >= 2) return;
    this.originPending.add(request.requestId);
    const end = Date.now() + request.timeoutMs;
    // The transport can emit its next request before the IPC acknowledgement
    // for our previous response returns. Keep one successor and answer it only
    // after that response completes, within the original received deadline.
    const previous = this.originTail;
    let release: (() => void) | undefined;
    this.originTail = new Promise<void>(resolve => {release = resolve;});
    try {
      await previous;
      while (current() && Date.now() < end) {
        const drained = await new Promise<boolean>(resolve => {
          let settled = false;
          const finish = (value: boolean) => {if (settled) return;settled = true;clearTimeout(timer);resolve(value);};
          const timer = setTimeout(() => finish(false), Math.max(1, end - Date.now()));
          this.terminal.write('', () => finish(true));
        });
        if (!drained) return;
        if (!current()) return;
        const observation = observeNativePromptOrigin(this.terminal, {...request.geometry, requestId: request.requestIndex});
        if (observation) {
          await invokeRespondTerminalPromptOrigin(request, observation);
          return;
        }
        const progressed = await new Promise<boolean>(resolve => {
          let settled = false;
          const disposables: Array<{ dispose(): void }> = [];
          const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            for (const disposable of disposables) disposable.dispose();
            resolve(value);
          };
          const timer = setTimeout(() => finish(false), Math.max(1, end - Date.now()));
          disposables.push(
            this.terminal.onWriteParsed(() => finish(true)),
            this.terminal.onCursorMove(() => finish(true)),
            this.terminal.onResize(() => finish(true)),
          );
        });
        if (!progressed) return;
      }
    } catch (error) {
      if (current()) logger.warn('Display origin observation could not be delivered', error);
    } finally {this.originPending.delete(request.requestId);release?.();}
  }

  pasteUserText(text: string, broadcast = false): void {
    if (this.disposed || this.getStatus(this.sessionId) !== 'connected' || !this.canWriteUserInput()) return;
    const sanitized = sanitizeBracketedPasteText(text);
    this.clearBroadcastOrigin();
    if (this.opened && this.terminal.textarea) {
      this.terminal.paste(sanitized);
    } else {
      void this.writeUserInput(formatTerminalPasteData(this.terminal, sanitized), false).catch((error) => {
        logger.error(`Failed to write paste input to session ${this.sessionId}`, error);
        this.showWriteFailure();
      });
    }
    if (!broadcast) return;
    this.broadcastInput((target) => target.writeUserInput(formatTerminalPasteData(target.terminal, sanitized)));
  }

  writeUserInput(data: string, broadcast = false): Promise<boolean> {
    if (this.disposed || this.getStatus(this.sessionId) !== 'connected') {
      return Promise.resolve(false);
    }
    if (!this.canWriteUserInput()) return Promise.resolve(false);
    const session = useTerminalStore.getState().sessions.find(item => item.sessionId === this.sessionId);
    if (session?.foregroundHandoffActive) return this.writeInput(data).then(() => true);
    this.reconcileSubmittedContinuation();
    if (/[\r\n\u0003]/.test(data)) {
      // Do not parse shell syntax to decide whether Enter completed a command.
      // Only a newer, trusted prompt event confirms that no accepted
      // continuation lines remain. Ctrl+U and ordinary PTY output cannot do so.
      this.lastInputLineBreak = { terminalSessionId: session?.terminalSessionId,
        generation: session?.terminalGeneration, revision: session?.integrationStateRevision };
    }
    if (this.terminal.buffer.active.type !== 'alternate') {
      this.trackUserInput(data);
    }
    const written = this.writeInput(data).then(() => true);
    if (broadcast) this.broadcastInput((target) => target.writeUserInput(data));
    return written;
  }

  writeUserBinaryInput(bytes: Uint8Array, broadcast = false): Promise<boolean> {
    if (this.disposed || this.getStatus(this.sessionId) !== 'connected') {
      return Promise.resolve(false);
    }
    if (!this.canWriteUserInput()) return Promise.resolve(false);
    const written = invokeWriteSessionBytes(this.sessionId, bytes).then(() => true);
    if (broadcast) this.broadcastInput((target) => target.writeUserBinaryInput(bytes));
    return written;
  }

  private broadcastInput(write: (controller: TerminalController) => Promise<boolean>): void {
    for (const sessionId of getTerminalBroadcastTargets(this.sessionId)) {
      const target = terminalRegistry.get(sessionId);
      if (!target) {
        logger.warn(`Broadcast target terminal controller missing for session ${sessionId}`);
        this.showBroadcastWriteFailure();
        continue;
      }
      void write(target).then((written) => {
        if (!written) {
          logger.warn(`Broadcast input rejected for target session ${sessionId}`);
          this.showBroadcastWriteFailure();
        }
      }).catch((error) => {
        logger.error(`Failed to broadcast input to session ${sessionId}`, error);
        this.showBroadcastWriteFailure();
      });
    }
  }

  writeInput(data: string): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error(`terminal controller ${this.sessionId} is disposed`));
    }
    if (this.getStatus(this.sessionId) !== 'connected') {
      return Promise.reject(new Error(`terminal session ${this.sessionId} is not connected`));
    }
    return invokeWriteSession(this.sessionId, data);
  }

  whenOutputReady(): Promise<void> {
    return this.listenerSetup;
  }

  subscribeOutput(listener: TerminalOutputCallback): () => void {
    if (this.disposed) return () => {};
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  subscribeDisplayOutput(listener: TerminalDisplayOutputCallback): () => void {
    if (this.disposed) return () => {};
    this.displayOutputListeners.add(listener);
    return () => this.displayOutputListeners.delete(listener);
  }

  subscribeDisplayOutputParsed(listener: TerminalDisplayOutputCallback): () => void {
    if (this.disposed) return () => {};
    this.displayOutputParsedListeners.add(listener);
    return () => this.displayOutputParsedListeners.delete(listener);
  }

  subscribeOutputFilter(filter: TerminalOutputFilter): () => void {
    if (this.disposed) return () => {};
    this.outputFilters.add(filter);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (!this.outputFilters.delete(filter)) return;
      this.writeVisibleSessionOutput(this.finishOutputFilter(filter));
    };
  }

  subscribeLifecycle(listener: TerminalLifecycleCallback): () => void {
    if (this.disposed) return () => {};
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  private emitLifecycle(event: TerminalLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn(`Terminal lifecycle subscriber failed for session ${event.sessionId}`, error);
      }
    }
  }

  write(chunk: string): void {
    this.emitDisplayOutput(chunk, 'local');
    this.terminal.write(chunk, this.displayOutputParsedCallback(chunk, 'local'));
  }

  private failureMessage: string | undefined;

  writeConnectionFailure(message: string): void {
    if (this.failureMessage === message) return;
    this.failureMessage = message;
    this.emitDisplayOutput('\r\n\u001b[?25l', 'local');
    this.terminal.write('\r\n\u001b[?25l', this.displayOutputParsedCallback('\r\n\u001b[?25l', 'local'));
    this.writeSystemLine(formatTerminalStatusLine('error', message));
    if (!this.isReadOnly()) {
      this.writeSystemLine(formatTerminalNoticeLine(t('terminal.notice.hintLabel'), t('terminal.notice.connectionFailedHint')));
    }
    this.inputBlockedNoticeRef = true;
  }

  clearConnectionFailure(): void {
    this.failureMessage = undefined;
  }

  writeDisconnectedHint(): void {
    this.writeSystemLine(this.isReadOnly()
      ? formatTerminalNoticeLine(t('terminal.notice.closedLabel'), undefined, '31')
      : formatTerminalNoticeLine(t('terminal.notice.hintLabel'), t('terminal.notice.disconnectedHint')));
    this.inputBlockedNoticeRef = true;
  }

  rebindSession(sessionId: string, ptyInfo?: SessionPtyInfo, options?: RebindSessionOptions): void {
    if (this.disposed || sessionId === this.sessionId) return;
    this.restoringDisplay = false;
    this.failureMessage = undefined;
    if (!options?.resetBuffer) {
      this.emitDisplayOutput('\u001b[?25h', 'local');
      this.terminal.write('\u001b[?25h', this.displayOutputParsedCallback('\u001b[?25h', 'local'));
    }
    const previousSessionId = this.sessionId;
    terminalInputReadiness.finish(previousSessionId);
    this.emitLifecycle({
      type: 'rebound',
      sessionId: previousSessionId,
      newSessionId: sessionId,
    });
    this.clearListeners();
    this.cancelPendingResize();
    this.cancelResizeRetry();
    this.queuedResizeDimensions = null;
    this.lastSentDimensions = null;
    this.sendingDimensions = null;
    this.resizeRetryAttempts = 0;
    this.cancelOutputResumeRetry();
    this.outputResumeRetryAttempts = 0;
    if (this.outputPaused) {
      this.setOutputPaused(false);
    }
    this.pendingOutputCharacters = 0;
    this.pendingUserInputText = '';
    this.submittedContinuationText = '';
    this.lastInputLineBreak = null;
    this.unverifiedUserSubmission = false;
    this.recentOutputTail = '';
    this.userInputSuppressions.clear();
    this.outputFilters.clear();
    this.agentInputBlockedFeedbackRef = false;
    this.outputGeneration += 1;
    this.commandDecorations.rebind();
    this.sessionId = sessionId;
    if (options?.resetBuffer) {
      clearTerminalOutput(previousSessionId);
      clearTerminalOutput(sessionId);
    } else {
      rebindTerminalOutput(previousSessionId, sessionId);
    }
    this.resetNoticeState();
    terminalInputReadiness.begin(sessionId);
    const generation = this.listenerGeneration;
    this.listenerSetup = this.closeInputRendering().then(() => {
      if (this.disposed || generation !== this.listenerGeneration) return;
      // Drain the old stream using its own transport behavior before switching
      // options. A fresh ConPTY starts with viewport-absolute cursor positions;
      // move the previous normal-screen cells into the existing scrollback so
      // its initial cursor-home cannot overwrite the prior connection history.
      // Use only standard stream/cursor/scroll operations, never reset/clear,
      // parser mutation, or replaying a separately stored copy of the text.
      this.terminal.options.windowsPty = resolveWindowsPty(ptyInfo);
      if (options?.resetBuffer) {
        this.terminal.reset();
        this.terminal.clearSelection();
      } else {
        const boundary = ptyInfo?.transportKind === 'windowsConPty' && this.terminal.buffer.active.type === 'normal'
          ? `\u001b\\\u001b[${this.terminal.rows};1H${'\r\n'.repeat(this.terminal.rows)}\u001b[H`
          : '\u001b\\';
        this.emitDisplayOutput(boundary, 'local');
        this.terminal.write(boundary, this.displayOutputParsedCallback(boundary, 'local'));
      }
      this.commandDecorations = this.installInputRendering(ptyInfo);
      return this.startListenerSetup(true);
    });
  }

  updateOptions(preferences: TerminalDisplayPreferences): void {
    if (this.disposed) return;
    const previous = this.preferences;
    this.preferences = preferences;
    const fontChanged = previous.fontFamily !== preferences.fontFamily || previous.customFontFamily !== preferences.customFontFamily;
    const geometryChanged =
      previous.fontSize !== preferences.fontSize
      || fontChanged
      || previous.lineHeight !== preferences.lineHeight
      || previous.letterSpacing !== preferences.letterSpacing;

    if (previous.fontSize !== preferences.fontSize) {
      this.terminal.options.fontSize = preferences.fontSize;
    }
    if (fontChanged) {
      this.terminal.options.fontFamily = terminalFontStack(preferences.fontFamily, preferences.customFontFamily);
    }
    if (previous.macOptionIsMeta !== preferences.macOptionIsMeta) {
      this.terminal.options.macOptionIsMeta = preferences.macOptionIsMeta ?? false;
    }
    if (previous.altClickMovesCursor !== preferences.altClickMovesCursor) {
      this.terminal.options.altClickMovesCursor = preferences.altClickMovesCursor ?? true;
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
    if (previous.colorScheme !== preferences.colorScheme || previous.colorOverrides !== preferences.colorOverrides) {
      const theme = resolveTerminalTheme(preferences.colorScheme, preferences.colorOverrides);
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
    if (Boolean(previous.webglRenderer) !== Boolean(preferences.webglRenderer)) {
      this.syncWebglRenderer(Boolean(preferences.webglRenderer));
    }
    if (geometryChanged && this.host) {
      const previousCols = this.terminal.cols;
      const previousRows = this.terminal.rows;
      try {
        this.fitAddon.fit();
      } catch {
        // The host can briefly be unmeasurable while switching sections.
      }
      if (this.terminal.cols !== previousCols || this.terminal.rows !== previousRows) {
        this.sendResize(this.terminal.cols, this.terminal.rows);
      }
    }
  }

  private syncWebglRenderer(enabled: boolean): void {
    this.webglLoadToken += 1;
    const token = this.webglLoadToken;
    if (!enabled || !this.opened || !this.host || this.disposed) {
      this.webglAddon?.dispose();
      this.webglAddon = undefined;
      return;
    }
    if (this.webglAddon) return;
    void import('@xterm/addon-webgl').then(({ WebglAddon }) => {
      if (this.disposed || !this.opened || !this.host || token !== this.webglLoadToken || !this.preferences.webglRenderer || this.webglAddon) {
        return;
      }
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          if (this.webglAddon === addon) {
            this.webglAddon = undefined;
          }
          try {
            addon.dispose();
          } catch {
            // Context already lost; DOM renderer takes over automatically.
          }
          logger.warn(`WebGL context lost for session ${this.sessionId}; fell back to DOM renderer`);
        });
        this.terminal.loadAddon(addon);
        this.webglAddon = addon;
      } catch (error) {
        logger.warn(`WebGL renderer unavailable for session ${this.sessionId}; using DOM renderer`, error);
      }
    }).catch((error) => {
      logger.warn(`Failed to load WebGL renderer addon for session ${this.sessionId}`, error);
    });
  }

  refreshTheme(): void {
    if (this.disposed || this.preferences.colorScheme !== 'app') return;
    const theme = resolveTerminalTheme('app', this.preferences.colorOverrides);
    this.terminal.options.theme = theme;
    this.updateElementStyles(theme);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    terminalInputReadiness.finish(this.sessionId);
    logger.debug(`Terminal disposed for session ${this.sessionId}`);
    this.emitLifecycle({ type: 'disposed', sessionId: this.sessionId });
    this.cancelOutputResumeRetry();
    this.cancelResizeRetry();
    this.queuedResizeDimensions = null;
    if (this.outputPaused) {
      this.setOutputPaused(false);
    }
    this.detach();
    this.clearListeners();
    this.linkProviderDisposable?.dispose();
    this.edgeBackground?.dispose();
    this.commandDecorations.dispose();
    this.nativeDisplay?.dispose();
    this.rawDisplay?.dispose();
    this.rawDisplay = undefined;
    this.scrollbarVisibility?.dispose();
    this.webglLoadToken += 1;
    this.webglAddon?.dispose();
    this.webglAddon = undefined;
    this.terminal.dispose();
    clearTerminalOutput(this.sessionId);
    this.outputListeners.clear();
    this.displayOutputListeners.clear();
    this.displayOutputParsedListeners.clear();
    this.outputFilters.clear();
    this.userInputSuppressions.clear();
    this.agentInputBlockedFeedbackRef = false;
    this.lifecycleListeners.clear();
    this.removeFromRegistry(this.sessionId);
  }
}

interface TerminalRegistry {
  measureInitialDimensions(sessionId: string): Promise<{ cols: number; rows: number } | undefined>;
  create(
    sessionId: string,
    setStatus: StatusCallback,
    setClosed: ClosedCallback,
    getStatus: GetStatusCallback,
    requestReconnect: RequestReconnectCallback,
    ptyInfo?: SessionPtyInfo,
  ): TerminalController;
  get(sessionId: string): TerminalController | undefined;
  rebindSession(oldSessionId: string, newSessionId: string, ptyInfo?: SessionPtyInfo, options?: RebindSessionOptions): void;
  updateOptions(preferences: TerminalDisplayPreferences): void;
  refreshTheme(): void;
  dispose(sessionId: string): void;
  disposeAll(): void;
  subscribe(listener: () => void): () => void;
}

// Agent event callbacks and mounted panes can outlive a module hot update.
// Keep their registry identity shared with controllers created after that update.
const retainedRegistry = import.meta.hot?.data?.terminalRegistry as TerminalRegistry | undefined;
export const terminalRegistry: TerminalRegistry = retainedRegistry ?? (() => {
  const controllers = new Map<string, TerminalController>();
  const listeners = new Set<() => void>();
  let preferences = DEFAULT_TERMINAL_PREFERENCES;

  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    async measureInitialDimensions(sessionId) {
      await document.fonts?.ready;
      // Let React commit the pending pane and the terminal section become visible.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const host = Array.from(document.querySelectorAll<HTMLElement>('[data-terminal-measure-session]'))
        .find((element) => element.dataset.terminalMeasureSession === sessionId);
      if (!host) return undefined;
      return measureTerminalGeometry(host, {
        fontFamily: terminalFontStack(preferences.fontFamily, preferences.customFontFamily),
        fontSize: preferences.fontSize,
        lineHeight: preferences.lineHeight,
        letterSpacing: preferences.letterSpacing,
      });
    },
    create(sessionId, setStatus, setClosed, getStatus, requestReconnect, ptyInfo) {
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
        ptyInfo,
      );
      controllers.set(sessionId, controller);
      notify();
      return controller;
    },
    get(sessionId) {
      return controllers.get(sessionId);
    },
    rebindSession(oldSessionId, newSessionId, ptyInfo, options) {
      if (oldSessionId === newSessionId) return;
      const controller = controllers.get(oldSessionId);
      if (!controller) return;
      controllers.get(newSessionId)?.dispose();
      controllers.delete(oldSessionId);
      controller.rebindSession(newSessionId, ptyInfo, options);
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

if (import.meta.hot?.data) {
  import.meta.hot.dispose((data) => {
    data.terminalRegistry = terminalRegistry;
  });
}
