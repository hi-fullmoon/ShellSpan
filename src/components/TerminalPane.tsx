import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { createPortal } from 'react-dom';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { createLogger } from '../lib/logger';
import { isTauriRuntime } from '../lib/tauri';
import { useSnippetsStore } from "../stores/snippetsStore";
import {
  formatTerminalNoticeLine,
  formatTerminalPrefixedText,
  formatTerminalStatusLine,
} from '../lib/terminal';
import {
  shouldDisableTerminalInput,
  shouldReconnectFromInput,
  shouldWarnOnClosedSession,
} from '../lib/terminal';
import { cn, getCurrentThemeMode, getTerminalTheme, getCursorStyle } from "../lib/ui";
import type {
  SessionState,
  SshClosedEvent,
  SshDataEvent,
  SshStatusEvent,
  TerminalTheme,
  CursorStyle,
} from "../types";

export interface TerminalPaneRef {
  sendData: (data: string) => void;
  exportBuffer: () => string;
}

interface TerminalPaneProps {
  session: SessionState;
  active: boolean;
  onReconnect: () => void;
  fontSize?: number;
  lineHeight?: number;
  terminalTheme?: TerminalTheme;
  cursorStyle?: CursorStyle;
  cursorBlink?: boolean;
  copyOnSelect?: boolean;
}

const terminalLogger = createLogger('terminal');
type CopyFeedback = 'copied' | 'failed';

interface ContextMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

function clampMenuPosition(x: number, y: number, width: number, height: number) {
  const edge = 8;
  return {
    x: Math.max(edge, Math.min(x, window.innerWidth - width - edge)),
    y: Math.max(edge, Math.min(y, window.innerHeight - height - edge)),
  };
}

export const TerminalPane = forwardRef<TerminalPaneRef, TerminalPaneProps>(function TerminalPane({
  session,
  active,
  onReconnect,
  fontSize = 14,
  lineHeight = 1.25,
  terminalTheme = 'default',
  cursorStyle = 'block',
  cursorBlink = true,
  copyOnSelect = false,
}, ref) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef(active);
  const copyOnSelectRef = useRef(copyOnSelect);
  const statusRef = useRef(session.status);
  const inputBlockedNoticeRef = useRef(false);
  const reconnectRequestedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const pendingResizeSyncRef = useRef<number | null>(null);
  const lastShellSizeRef = useRef<{ width: number; height: number } | null>(null);
  const scheduleResizeRef = useRef<((force?: boolean) => void) | null>(null);
  const needsSystemLineBreakRef = useRef(false);
  const needsConnectedShellSpacingRef = useRef(false);
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [snippetSubmenuOpen, setSnippetSubmenuOpen] = useState(false);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const snippets = useSnippetsStore((state) => state.snippets);

  const showCopyFeedback = (feedback: CopyFeedback) => {
    if (!mountedRef.current) {
      return;
    }
    if (copyFeedbackTimerRef.current !== null) {
      window.clearTimeout(copyFeedbackTimerRef.current);
    }
    setCopyFeedback(feedback);
    copyFeedbackTimerRef.current = window.setTimeout(() => {
      copyFeedbackTimerRef.current = null;
      setCopyFeedback(null);
    }, 1000);
  };

  const handleContextMenuCopy = async () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const selection = terminal.getSelection();
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection);
      showCopyFeedback("copied");
    } catch {
      showCopyFeedback("failed");
    }
    setContextMenu(null);
  };

  const handleContextMenuPaste = async () => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      if (statusRef.current === "connected") {
        await invoke("write_session", {
          sessionId: session.sessionId,
          data: text,
        });
      } else {
        terminal.write(text);
      }
    } catch {
      showCopyFeedback("failed");
    }
    setContextMenu(null);
  };

  const handleContextMenuSelectAll = () => {
    terminalRef.current?.selectAll();
    setContextMenu(null);
  };

  const handleContextMenuClear = () => {
    terminalRef.current?.clear();
    setContextMenu(null);
  };

  const handleContextMenuFind = () => {
    setShowSearch(true);
    setContextMenu(null);
  };

  const handleSendSnippet = (command: string) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const data = command + "\r";
    if (statusRef.current === "connected") {
      void invoke("write_session", {
        sessionId: session.sessionId,
        data,
      }).catch((error) => {
        terminalLogger.error("快捷命令发送失败", {
          sessionId: session.sessionId,
          error: String(error),
        });
      });
    } else {
      terminal.write(data);
    }
    setContextMenu(null);
  };

  const writeSystemLine = (line: string) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const prefix = needsSystemLineBreakRef.current ? '\r\n' : '';
    terminal.writeln(`${prefix}${line}`);
    needsSystemLineBreakRef.current = false;
  };

  const syncSystemLineBreakStateFromChunk = (chunk: string) => {
    if (!chunk) {
      return;
    }

    needsSystemLineBreakRef.current = !/[\r\n]$/.test(chunk);
  };

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    copyOnSelectRef.current = copyOnSelect;
  }, [copyOnSelect]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyFeedbackTimerRef.current !== null) {
        window.clearTimeout(copyFeedbackTimerRef.current);
        copyFeedbackTimerRef.current = null;
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) {
      return;
    }
    const rect = menuRef.current.getBoundingClientRect();
    const nextPosition = clampMenuPosition(contextMenu.x, contextMenu.y, rect.width, rect.height);
    if (nextPosition.x === contextMenu.x && nextPosition.y === contextMenu.y) {
      return;
    }
    setContextMenu((current) =>
      current ? { ...current, x: nextPosition.x, y: nextPosition.y } : current,
    );
  }, [contextMenu]);

  useLayoutEffect(() => {
    if (!snippetSubmenuOpen || !menuRef.current || !submenuRef.current || !contextMenu) {
      return;
    }
    const menuRect = menuRef.current.getBoundingClientRect();
    const submenuRect = submenuRef.current.getBoundingClientRect();
    const edge = 8;
    const wouldOverflowRight = menuRect.right + submenuRect.width + edge > window.innerWidth;
    if (wouldOverflowRight) {
      submenuRef.current.style.left = "auto";
      submenuRef.current.style.right = "100%";
      submenuRef.current.style.marginLeft = "0";
      submenuRef.current.style.marginRight = "4px";
    } else {
      submenuRef.current.style.left = "100%";
      submenuRef.current.style.right = "auto";
      submenuRef.current.style.marginLeft = "4px";
      submenuRef.current.style.marginRight = "0";
    }
  }, [snippetSubmenuOpen, contextMenu]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const handleWindowClick = () => setContextMenu(null);
    window.addEventListener("click", handleWindowClick);
    return () => window.removeEventListener("click", handleWindowClick);
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) {
      setSnippetSubmenuOpen(false);
    }
  }, [contextMenu]);

  useImperativeHandle(ref, () => ({
    sendData: (data: string) => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      if (statusRef.current === "connected") {
        void invoke("write_session", {
          sessionId: session.sessionId,
          data,
        }).catch((error) => {
          terminalLogger.error("Snippet 写入失败", {
            sessionId: session.sessionId,
            error: String(error),
          });
        });
        } else {
          terminal.write(data);
        }
      },
      exportBuffer: () => {
        const terminal = terminalRef.current;
        if (!terminal) return '';
        const lines: string[] = [];
        const buffer = terminal.buffer.active;
        for (let y = 0; y < buffer.length; y++) {
          const line = buffer.getLine(y);
          if (line) {
            lines.push(line.translateToString(true));
          }
        }
        return lines.join('\n');
      },
    }),
    [session.sessionId],
  );

  useEffect(() => {
    statusRef.current = session.status;
    if (terminalRef.current) {
      terminalRef.current.options.disableStdin = shouldDisableTerminalInput(session.status);
    }
    if (session.status === 'connected') {
      inputBlockedNoticeRef.current = false;
      reconnectRequestedRef.current = false;
    }
  }, [session.status]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.fontSize = fontSize;
      terminalRef.current.options.lineHeight = lineHeight;
      terminalRef.current.options.theme = getTerminalTheme(terminalTheme, getCurrentThemeMode());
      terminalRef.current.options.cursorStyle = getCursorStyle(cursorStyle);
      terminalRef.current.options.cursorBlink = cursorBlink;
      terminalRef.current.refresh?.(0, terminalRef.current.rows - 1);
      scheduleResizeRef.current?.(true);
    }
  }, [fontSize, lineHeight, terminalTheme, cursorStyle, cursorBlink]);

  useEffect(() => {
    if (!shellRef.current || terminalRef.current) {
      return;
    }

    terminalLogger.info('初始化终端面板', { sessionId: session.sessionId });

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
      disableStdin: shouldDisableTerminalInput(session.status),
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.open(shellRef.current);
    // @xterm/xterm may not have renderer dimensions ready immediately after open.
    // Defer fit to the next frame to avoid runtime errors in syncScrollArea.
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

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (!terminalRef.current) return;
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        hasSelection: !!terminalRef.current.getSelection(),
      });
    };
    terminal.element?.addEventListener("contextmenu", handleContextMenu);

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
        showCopyFeedback('failed');
        return;
      }

      void writeText
        .call(navigator.clipboard, selection)
        .then(() => showCopyFeedback('copied'))
        .catch(() => showCopyFeedback('failed'));
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (!activeRef.current) {
        return true;
      }
      if (event.type === 'keydown') {
        const isCtrlOrMeta = event.ctrlKey || event.metaKey;
        if (isCtrlOrMeta && event.key === 'f') {
          event.preventDefault();
          setShowSearch(true);
          return false;
        }
        if (event.key === 'Escape') {
          setShowSearch((current) => {
            if (current) {
              searchAddonRef.current?.clearDecorations?.();
              return false;
            }
            return current;
          });
        }
      }
      return true;
    });
    writeSystemLine(formatTerminalPrefixedText(t('terminal.notice.preparing')));

    const themeObserver = new MutationObserver(() => {
      const nextTerminal = terminalRef.current;
      if (!nextTerminal) {
        return;
      }

      nextTerminal.options.theme = getTerminalTheme(terminalTheme, getCurrentThemeMode());
      nextTerminal.refresh?.(0, nextTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    terminal.onData((data) => {
      if (statusRef.current !== 'connected') {
        const shouldReconnect = shouldReconnectFromInput(statusRef.current, data);

        if (shouldReconnect && !reconnectRequestedRef.current) {
          reconnectRequestedRef.current = true;
          writeSystemLine(formatTerminalNoticeLine(t('terminal.notice.reconnectingLabel'), t('terminal.notice.reconnectingMessage'), '36'));
          onReconnect();
          return;
        }

        if (!inputBlockedNoticeRef.current) {
          writeSystemLine(formatTerminalNoticeLine(t('terminal.notice.hintLabel'), t('terminal.notice.disconnectedHint')));
          inputBlockedNoticeRef.current = true;
        }
        return;
      }

      invoke('write_session', {
        sessionId: session.sessionId,
        data,
      }).catch((error) => {
        terminalLogger.error('写入会话失败', {
          sessionId: session.sessionId,
          error: String(error),
        });
        inputBlockedNoticeRef.current = true;
        writeSystemLine(formatTerminalNoticeLine(t('terminal.notice.writeFailedLabel'), t('terminal.notice.writeFailedMessage'), '31'));
      });
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
          sessionId: session.sessionId,
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
      if (!activeRef.current || !shell || !nextTerminal || !nextFitAddon) {
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
      terminalLogger.debug("销毁终端实例", { sessionId: session.sessionId });
      terminal.element?.removeEventListener("contextmenu", handleContextMenu);
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
  }, [session.sessionId]);

  useEffect(() => {
    if (!active) {
      return;
    }

    scheduleResizeRef.current?.(true);
    const nextTerminal = terminalRef.current;
    if (!nextTerminal) {
      return;
    }

    const focusFrame = requestAnimationFrame(() => {
      if (activeRef.current) {
        nextTerminal.focus();
      }
    });

    return () => {
      cancelAnimationFrame(focusFrame);
    };
  }, [active, session.sessionId]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      terminalLogger.warn('非 Tauri 运行时，跳过终端事件监听', {
        sessionId: session.sessionId,
      });
      return;
    }

    let disposeData: UnlistenFn | undefined;
    let disposeStatus: UnlistenFn | undefined;
    let disposeClosed: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      const nextDisposeData = await listen<SshDataEvent>('ssh-data', (event) => {
        if (event.payload.sessionId !== session.sessionId) {
          return;
        }
        if (needsConnectedShellSpacingRef.current) {
          terminalRef.current?.write('\r\n');
          needsConnectedShellSpacingRef.current = false;
        }
        terminalRef.current?.write(event.payload.chunk);
        syncSystemLineBreakStateFromChunk(event.payload.chunk);
      });

      if (cancelled) {
        nextDisposeData();
        return;
      }
      disposeData = nextDisposeData;

      const nextDisposeStatus = await listen<SshStatusEvent>('ssh-status', (event) => {
        if (event.payload.sessionId !== session.sessionId) {
          return;
        }
        terminalLogger.info('会话状态更新', event.payload);
        writeSystemLine(formatTerminalStatusLine(event.payload.status, event.payload.message));
        needsConnectedShellSpacingRef.current = event.payload.status === 'connected';
      });

      if (cancelled) {
        nextDisposeStatus();
        return;
      }
      disposeStatus = nextDisposeStatus;

      const nextDisposeClosed = await listen<SshClosedEvent>('ssh-closed', (event) => {
        if (event.payload.sessionId !== session.sessionId) {
          return;
        }
        if (shouldWarnOnClosedSession(statusRef.current)) {
          terminalLogger.warn('会话关闭事件', event.payload);
        } else {
          terminalLogger.debug('会话关闭事件（错误态已记录）', event.payload);
        }
        writeSystemLine(
          formatTerminalNoticeLine(t('terminal.notice.closedLabel'), event.payload.reason ? `: ${event.payload.reason}` : undefined, '31'),
        );
        writeSystemLine(formatTerminalNoticeLine(t('terminal.notice.hintLabel'), t('terminal.notice.pressEnterReconnect')));
        inputBlockedNoticeRef.current = true;
      });

      if (cancelled) {
        nextDisposeClosed();
        return;
      }
      disposeClosed = nextDisposeClosed;
    };

    void attach();

    return () => {
      cancelled = true;
      disposeData?.();
      disposeStatus?.();
      disposeClosed?.();
    };
  }, [session.sessionId]);

  useEffect(() => {
    if (showSearch) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
    }
  }, [showSearch]);

  const performSearch = (direction: 'next' | 'previous') => {
    const addon = searchAddonRef.current;
    if (!addon || !searchTerm) {
      return;
    }
    const options = { caseSensitive };
    if (direction === 'next') {
      addon.findNext(searchTerm, options);
    } else {
      addon.findPrevious(searchTerm, options);
    }
  };

  const closeSearch = () => {
    searchAddonRef.current?.clearDecorations?.();
    setShowSearch(false);
    setSearchTerm('');
    terminalRef.current?.focus();
  };

  return (
    <section className={cn('absolute inset-0 flex flex-col', active ? 'opacity-100' : 'pointer-events-none opacity-0')}>
      {showSearch && (
        <div
          className="absolute right-2 top-2 z-30 flex items-center gap-1.5 rounded-lg p-1.5 backdrop-blur-sm"
          style={{ background: 'var(--app-surface)', border: '1px solid var(--app-border)', boxShadow: 'var(--app-shadow)' }}
        >
          <input
            ref={searchInputRef}
            className="themed-input h-7 w-44 px-2 text-xs outline-none"
            placeholder={t('terminal.search.placeholder')}
            type="text"
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              if (e.target.value) {
                searchAddonRef.current?.findNext?.(e.target.value, { caseSensitive });
              } else {
                searchAddonRef.current?.clearDecorations?.();
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                performSearch(e.shiftKey ? 'previous' : 'next');
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
              }
            }}
          />
          <button
            className="icon-btn h-6 w-6 px-0 text-xs"
            onClick={() => performSearch('previous')}
            title={t('terminal.search.previous')}
            type="button"
          >
            ↑
          </button>
          <button className="icon-btn h-6 w-6 px-0 text-xs" onClick={() => performSearch('next')} title={t('terminal.search.next')} type="button">
            ↓
          </button>
          <button
            className={cn('icon-btn h-6 w-6 px-0 text-xs', caseSensitive && 'bg-cyan-500/20 text-cyan-300')}
            onClick={() => {
              const next = !caseSensitive;
              setCaseSensitive(next);
              if (searchTerm) {
                searchAddonRef.current?.findNext?.(searchTerm, { caseSensitive: next });
              }
            }}
            title={t('terminal.search.caseSensitive')}
            type="button"
          >
            Aa
          </button>
          <button className="icon-btn h-6 w-6 px-0 text-xs" onClick={closeSearch} title={t('terminal.search.close')} type="button">
            ✕
          </button>
        </div>
      )}
      <div className="terminal-shell themed-terminal-shell min-h-0 flex-1 overflow-hidden" ref={shellRef} />
      {copyFeedback && (
        <div
          aria-live="polite"
          className={cn(
            'terminal-copy-feedback absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-sm px-2 py-1 text-xs',
            copyFeedback === 'failed' && 'terminal-copy-feedback-error',
          )}
          role="status"
        >
          {copyFeedback === 'copied' ? t('terminal.feedback.copied') : t('terminal.feedback.copyFailed')}
        </div>
      )}
      {contextMenu
        ? createPortal(
            <div
              className="themed-menu fixed z-50 min-w-28 rounded-lg p-1 backdrop-blur"
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
              ref={menuRef}
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              <div className="flex flex-col">
                <button
                  className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                  disabled={!contextMenu.hasSelection}
                  onClick={handleContextMenuCopy}
                  type="button"
                >
                  {t('terminal.contextMenu.copy')}
                </button>
                <button
                  className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                  onClick={handleContextMenuPaste}
                  type="button"
                >
                  {t('terminal.contextMenu.paste')}
                </button>
                <div className="themed-menu-divider my-1 h-px" />
                <button
                  className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                  onClick={handleContextMenuSelectAll}
                  type="button"
                >
                  {t('terminal.contextMenu.selectAll')}
                </button>
                <div className="themed-menu-divider my-1 h-px" />
                <button
                  className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                  onClick={handleContextMenuClear}
                  type="button"
                >
                  {t('terminal.contextMenu.clear')}
                </button>
                <div className="themed-menu-divider my-1 h-px" />
                <button
                  className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                  onClick={handleContextMenuFind}
                  type="button"
                >
                  {t('terminal.contextMenu.find')}
                </button>
                <div
                  className="relative"
                  onMouseEnter={() => setSnippetSubmenuOpen(true)}
                  onMouseLeave={() => setSnippetSubmenuOpen(false)}
                >
                  <button
                    className="themed-menu-item flex w-full items-center justify-between whitespace-nowrap px-2 py-1 text-left text-xs transition"
                    disabled={snippets.length === 0}
                    type="button"
                  >
                    <span>{t('terminal.contextMenu.snippets')}</span>
                    <span className="text-[10px] text-slate-400">▸</span>
                  </button>
                  {snippetSubmenuOpen && (
                    <div
                      className="themed-menu absolute top-0 z-50 min-w-28 rounded-lg p-1 backdrop-blur"
                      ref={submenuRef}
                      style={{ left: "100%", marginLeft: "4px" }}
                    >
                      {snippets.length === 0 ? (
                        <div className="px-2 py-1 text-[11px] text-slate-400">
                          {t('terminal.contextMenu.noSnippets')}
                        </div>
                      ) : (
                        <div className="flex max-h-60 flex-col overflow-auto">
                          {snippets.map((snippet) => (
                            <button
                              className="themed-menu-item w-full whitespace-nowrap px-2 py-1 text-left text-xs transition"
                              key={snippet.id}
                              onClick={() => handleSendSnippet(snippet.command)}
                              title={snippet.command}
                              type="button"
                            >
                              {snippet.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
});
