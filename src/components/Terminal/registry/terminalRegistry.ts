import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import {
  invokeResizeSession,
  invokeWriteSession,
  listenToSshClosed,
  listenToSshData,
  listenToSshStatus,
} from '@/lib/tauri';
import type { ClosedEvent, StatusEvent } from '@/types';

export type StatusCallback = (sessionId: string, payload: StatusEvent) => void;
export type ClosedCallback = (sessionId: string, payload: ClosedEvent) => void;

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
  write(chunk: string): void;
  dispose(): void;
}

class TerminalControllerImpl implements TerminalController {
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

  constructor(
    sessionId: string,
    setStatus: StatusCallback,
    setClosed: ClosedCallback,
  ) {
    this.sessionId = sessionId;
    this.setStatus = setStatus;
    this.setClosed = setClosed;

    this.terminal = new Terminal({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: 'var(--app-surface)',
        foreground: 'var(--app-text)',
        cursor: 'var(--app-primary)',
      },
      cursorBlink: true,
      scrollback: 10000,
    });
    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.searchAddon);

    this.container = document.createElement('div');
    this.container.className = 'h-full w-full';

    this.unlisten = {
      data: undefined,
      status: undefined,
      closed: undefined,
    };

    this.terminal.onData((data) => {
      invokeWriteSession(this.sessionId, data).catch(() => {});
    });

    void this.setupListeners();
  }

  private async setupListeners(): Promise<void> {
    const dataUnlisten = await listenToSshData(this.sessionId, (event) => {
      this.terminal.write(event.payload.chunk);
    });
    if (this.disposed) {
      dataUnlisten();
      return;
    }
    this.unlisten.data = dataUnlisten;

    const statusUnlisten = await listenToSshStatus(this.sessionId, (event) => {
      this.setStatus(this.sessionId, event.payload);
    });
    if (this.disposed) {
      statusUnlisten();
      return;
    }
    this.unlisten.status = statusUnlisten;

    const closedUnlisten = await listenToSshClosed(this.sessionId, (event) => {
      this.setClosed(this.sessionId, event.payload);
    });
    if (this.disposed) {
      closedUnlisten();
      return;
    }
    this.unlisten.closed = closedUnlisten;
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

    try {
      this.fitAddon.fit();
    } catch {
      // fit() can fail without a measurable container; harmless.
    }

    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.container.offsetParent === null) return;
        try {
          this.fitAddon.fit();
        } catch {
          return;
        }
        invokeResizeSession(
          this.sessionId,
          this.terminal.cols,
          this.terminal.rows,
        ).catch(() => {});
      });
      this.resizeObserver.observe(this.container);
    }

    // Initial resize now that cols/rows are measurable after open().
    if (this.opened) {
      invokeResizeSession(
        this.sessionId,
        this.terminal.cols,
        this.terminal.rows,
      ).catch(() => {});
    }

    this.host = host;
  }

  detach(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.container.remove();
    this.host = null;
  }

  write(chunk: string): void {
    this.terminal.write(chunk);
  }

  dispose(): void {
    this.disposed = true;
    this.detach();
    this.unlisten.data?.();
    this.unlisten.status?.();
    this.unlisten.closed?.();
    this.unlisten = { data: undefined, status: undefined, closed: undefined };
    this.terminal.dispose();
  }
}

interface TerminalRegistry {
  create(sessionId: string, setStatus: StatusCallback, setClosed: ClosedCallback): TerminalController;
  get(sessionId: string): TerminalController | undefined;
  dispose(sessionId: string): void;
  disposeAll(): void;
}

export const terminalRegistry: TerminalRegistry = (() => {
  const controllers = new Map<string, TerminalController>();

  return {
    create(sessionId, setStatus, setClosed) {
      const existing = controllers.get(sessionId);
      if (existing) {
        existing.dispose();
      }
      const controller = new TerminalControllerImpl(
        sessionId,
        setStatus,
        setClosed,
      );
      controllers.set(sessionId, controller);
      return controller;
    },
    get(sessionId) {
      return controllers.get(sessionId);
    },
    dispose(sessionId) {
      const controller = controllers.get(sessionId);
      if (!controller) return;
      controller.dispose();
      controllers.delete(sessionId);
    },
    disposeAll() {
      for (const controller of controllers.values()) {
        controller.dispose();
      }
      controllers.clear();
    },
  };
})();