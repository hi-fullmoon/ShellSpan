import { useCallback, useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';
import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '../lib/logger';
import { getCurrentThemeMode, getCursorStyle, getTerminalTheme } from '../lib/ui';
import { isTauriRuntime } from '../lib/tauri';
import { shouldDisableTerminalInput } from '../lib/terminal';
import type { CursorStyle, TerminalTheme, SessionStatus } from '../types';

const terminalLogger = createLogger('terminal');

function isAliveGuard(terminal: Terminal | null, disposed: boolean): terminal is Terminal {
  return !disposed && terminal !== null;
}

export interface UseTerminalOptions {
  sessionId: string;
  status: SessionStatus;
  active: boolean;
  fontSize: number;
  lineHeight: number;
  terminalTheme: TerminalTheme;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  copyOnSelect: boolean;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  onCopyFeedback: (feedback: 'copied' | 'failed') => void;
}

export interface UseTerminalReturn {
  shellRef: React.RefObject<HTMLDivElement | null>;
  terminalRef: React.RefObject<Terminal | null>;
  searchAddonRef: React.RefObject<SearchAddon | null>;
  scheduleResizeRef: React.RefObject<((force?: boolean) => void) | null>;
  focus: () => void;
  isAlive: () => boolean;
}

export function useTerminal({
  sessionId,
  status,
  active,
  fontSize,
  lineHeight,
  terminalTheme,
  cursorStyle,
  cursorBlink,
  copyOnSelect,
  onOpenSearch,
  onCloseSearch,
  onCopyFeedback,
}: UseTerminalOptions): UseTerminalReturn {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const activeRef = useRef(active);
  const copyOnSelectRef = useRef(copyOnSelect);
  const terminalThemeRef = useRef(terminalTheme);
  const frameRef = useRef<number | null>(null);
  const pendingResizeSyncRef = useRef<number | null>(null);
  const lastShellSizeRef = useRef<{ width: number; height: number } | null>(null);
  const scheduleResizeRef = useRef<((force?: boolean) => void) | null>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    copyOnSelectRef.current = copyOnSelect;
  }, [copyOnSelect]);

  useEffect(() => {
    terminalThemeRef.current = terminalTheme;
  }, [terminalTheme]);

  const focus = useCallback(() => {
    const terminal = terminalRef.current;
    if (isAliveGuard(terminal, disposedRef.current)) {
      terminal.focus();
    }
  }, []);

  const isAlive = useCallback(() => {
    return isAliveGuard(terminalRef.current, disposedRef.current);
  }, []);

  // Sync terminal options when preferences change (without recreating Terminal).
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!isAliveGuard(terminal, disposedRef.current)) {
      return;
    }

    terminal.options.fontSize = fontSize;
    terminal.options.lineHeight = lineHeight;
    terminal.options.theme = getTerminalTheme(terminalTheme, getCurrentThemeMode());
    terminal.options.cursorStyle = getCursorStyle(cursorStyle);
    terminal.options.cursorBlink = cursorBlink;
    terminal.refresh?.(0, terminal.rows - 1);
    scheduleResizeRef.current?.(true);
  }, [fontSize, lineHeight, terminalTheme, cursorStyle, cursorBlink]);

  // Sync disableStdin when session status changes.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!isAliveGuard(terminal, disposedRef.current)) {
      return;
    }
    terminal.options.disableStdin = shouldDisableTerminalInput(status);
  }, [status]);

  // Create and dispose the xterm instance.
  useEffect(() => {
    if (!shellRef.current || terminalRef.current) {
      return;
    }

    disposedRef.current = false;
    terminalLogger.info('初始化终端面板', { sessionId });

    const terminal = new Terminal({
      cursorBlink,
      cursorStyle: getCursorStyle(cursorStyle),
      allowProposedApi: true,
      convertEol: true,
      fontFamily: '"JetBrains Mono", "SF Mono", "Cascadia Code", Consolas, monospace',
      fontSize,
      lineHeight,
      theme: getTerminalTheme(terminalTheme, getCurrentThemeMode()),
      scrollback: 5000,
      disableStdin: shouldDisableTerminalInput(status),
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.open(shellRef.current);

    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        // A later resize pass will retry fitting.
      }
    });

    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    searchAddonRef.current = searchAddon;
    lastShellSizeRef.current = null;

    terminal.onSelectionChange(() => {
      if (!copyOnSelectRef.current) {
        return;
      }

      const selection = terminal.getSelection();
      if (!selection) {
        return;
      }

      const writeText = navigator.clipboard?.writeText;
      if (!writeText) {
        onCopyFeedback('failed');
        return;
      }

      void writeText
        .call(navigator.clipboard, selection)
        .then(() => onCopyFeedback('copied'))
        .catch(() => onCopyFeedback('failed'));
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (!activeRef.current) {
        return true;
      }

      if (event.type !== 'keydown') {
        return true;
      }

      const isCtrlOrMeta = event.ctrlKey || event.metaKey;
      if (isCtrlOrMeta && event.key === 'f') {
        event.preventDefault();
        onOpenSearch();
        return false;
      }

      if (event.key === 'Escape') {
        onCloseSearch();
        return false;
      }

      return true;
    });

    const themeObserver = new MutationObserver(() => {
      const nextTerminal = terminalRef.current;
      if (!isAliveGuard(nextTerminal, disposedRef.current)) {
        return;
      }

      nextTerminal.options.theme = getTerminalTheme(terminalThemeRef.current, getCurrentThemeMode());
      nextTerminal.refresh?.(0, nextTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    const clearPendingResizeSync = () => {
      if (pendingResizeSyncRef.current !== null) {
        window.clearTimeout(pendingResizeSyncRef.current);
        pendingResizeSyncRef.current = null;
      }
    };

    const syncSessionSize = (nextTerminal: Terminal, immediate = false) => {
      if (!isTauriRuntime()) {
        return;
      }

      const sendResize = () => {
        void invoke('resize_session', {
          sessionId,
          cols: nextTerminal.cols,
          rows: nextTerminal.rows,
        });
      };

      if (immediate) {
        clearPendingResizeSync();
        sendResize();
        return;
      }

      clearPendingResizeSync();
      pendingResizeSyncRef.current = window.setTimeout(() => {
        pendingResizeSyncRef.current = null;
        sendResize();
      }, 80);
    };

    const performResize = (force = false) => {
      frameRef.current = null;
      const shell = shellRef.current;
      const nextTerminal = terminalRef.current;
      const nextFitAddon = fitRef.current;
      if (!activeRef.current || !shell || !isAliveGuard(nextTerminal, disposedRef.current) || !nextFitAddon) {
        return;
      }

      const width = shell.clientWidth;
      const height = shell.clientHeight;
      if (width <= 0 || height <= 0) {
        return;
      }

      const previousSize = lastShellSizeRef.current;
      if (!force && previousSize && previousSize.width === width && previousSize.height === height) {
        return;
      }

      lastShellSizeRef.current = { width, height };

      try {
        nextFitAddon.fit();
      } catch {
        return;
      }

      syncSessionSize(nextTerminal, force);
    };

    const scheduleResize = (force = false) => {
      if (!activeRef.current) {
        return;
      }

      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }

      frameRef.current = requestAnimationFrame(() => performResize(force));
    };
    scheduleResizeRef.current = scheduleResize;

    const handleViewportResize = () => {
      scheduleResize(false);
    };

    scheduleResize(true);
    const resizeObserver = new ResizeObserver(handleViewportResize);
    resizeObserver.observe(shellRef.current);
    window.addEventListener('resize', handleViewportResize);

    return () => {
      terminalLogger.debug('销毁终端实例', { sessionId });
      disposedRef.current = true;
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleViewportResize);
      scheduleResizeRef.current = null;
      clearPendingResizeSync();
      lastShellSizeRef.current = null;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      terminal.dispose();
      themeObserver.disconnect();
      terminalRef.current = null;
      fitRef.current = null;
      searchAddonRef.current = null;
    };
  }, [sessionId]);

  // Focus when this pane becomes active.
  useEffect(() => {
    if (!active) {
      return;
    }

    scheduleResizeRef.current?.(true);
    const terminal = terminalRef.current;
    if (!isAliveGuard(terminal, disposedRef.current)) {
      return;
    }

    const focusFrame = requestAnimationFrame(() => {
      const nextTerminal = terminalRef.current;
      if (activeRef.current && isAliveGuard(nextTerminal, disposedRef.current)) {
        nextTerminal.focus();
      }
    });

    return () => {
      cancelAnimationFrame(focusFrame);
    };
  }, [active, sessionId]);

  return {
    shellRef,
    terminalRef,
    searchAddonRef,
    scheduleResizeRef,
    focus,
    isAlive,
  };
}

