import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import {
  invokeResizeSession,
  invokeWriteSession,
  listenToSshClosed,
  listenToSshData,
  listenToSshStatus,
} from '@/lib/tauri';
import { useTerminalStore } from '@/stores/terminalStore';
import type { TerminalSession } from '@/stores/terminalStore';

export interface TerminalSessionController {
  findNext: (query: string) => boolean;
  findPrevious: (query: string) => boolean;
  closeSearch: () => void;
}

export function useTerminalSession(
  session: TerminalSession,
  containerRef: React.RefObject<HTMLDivElement | null>,
): TerminalSessionController {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const setStatus = useTerminalStore((state) => state.setStatus);
  const setClosed = useTerminalStore((state) => state.setClosed);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
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
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminal.onData((data) => {
      invokeWriteSession(session.sessionId, data).catch(() => {
        // Ignore write errors after close.
      });
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    const cols = terminal.cols;
    const rows = terminal.rows;
    invokeResizeSession(session.sessionId, cols, rows).catch(() => {
      // Ignore resize errors.
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const current = terminalRef.current;
      if (current) {
        invokeResizeSession(session.sessionId, current.cols, current.rows).catch(() => {
          // Ignore.
        });
      }
    });
    resizeObserver.observe(containerRef.current);

    let unlistenData: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let unlistenClosed: (() => void) | undefined;

    const setupListeners = async (): Promise<void> => {
      unlistenData = await listenToSshData(session.sessionId, (event) => {
        terminal.write(event.payload.chunk);
      });
      unlistenStatus = await listenToSshStatus(
        session.sessionId,
        (event) => {
          setStatus(session.sessionId, event.payload);
        },
      );
      unlistenClosed = await listenToSshClosed(session.sessionId, (event) => {
        setClosed(session.sessionId, event.payload);
      });
    };

    setupListeners();

    return () => {
      resizeObserver.disconnect();
      unlistenData?.();
      unlistenStatus?.();
      unlistenClosed?.();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [session.sessionId, containerRef, setStatus, setClosed]);

  return {
    findNext: (query: string) => {
      const search = searchAddonRef.current;
      if (!search) return false;
      return search.findNext(query);
    },
    findPrevious: (query: string) => {
      const search = searchAddonRef.current;
      if (!search) return false;
      return search.findPrevious(query);
    },
    closeSearch: () => {
      const search = searchAddonRef.current;
      if (!search) return;
      search.clearDecorations();
    },
  };
}
