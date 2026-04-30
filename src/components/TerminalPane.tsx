import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { createLogger } from '../lib/logger';
import { isTauriRuntime } from '../lib/tauri';
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

const terminalLogger = createLogger("terminal");

export function TerminalPane({
  session,
  active,
  onReconnect,
  fontSize = 14,
  lineHeight = 1.25,
  terminalTheme = 'default',
  cursorStyle = 'block',
  cursorBlink = true,
  copyOnSelect = false,
}: TerminalPaneProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef(active);
  const statusRef = useRef(session.status);
  const inputBlockedNoticeRef = useRef(false);
  const reconnectRequestedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const pendingResizeSyncRef = useRef<number | null>(null);
  const lastShellSizeRef = useRef<{ width: number; height: number } | null>(null);
  const scheduleResizeRef = useRef<((force?: boolean) => void) | null>(null);
  const needsSystemLineBreakRef = useRef(false);
  const needsConnectedShellSpacingRef = useRef(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);

  const writeSystemLine = (line: string) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const prefix = needsSystemLineBreakRef.current ? "\r\n" : "";
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
    statusRef.current = session.status;
    if (terminalRef.current) {
      terminalRef.current.options.disableStdin = shouldDisableTerminalInput(
        session.status,
      );
    }
    if (session.status === "connected") {
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

    terminalLogger.info("初始化终端面板", { sessionId: session.sessionId });

    const terminal = new Terminal({
      cursorBlink,
      cursorStyle: getCursorStyle(cursorStyle),
      allowProposedApi: true,
      convertEol: true,
      fontFamily:
        '"JetBrains Mono", "SF Mono", "Cascadia Code", Consolas, monospace',
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

    if (copyOnSelect) {
      terminal.onSelectionChange(() => {
        const selection = terminal.getSelection();
        if (selection) {
          void navigator.clipboard.writeText(selection);
        }
      });
    }

    terminal.attachCustomKeyEventHandler((event) => {
      if (!activeRef.current) {
        return true;
      }
      if (event.type === "keydown") {
        const isCtrlOrMeta = event.ctrlKey || event.metaKey;
        if (isCtrlOrMeta && event.key === "f") {
          event.preventDefault();
          setShowSearch(true);
          return false;
        }
        if (event.key === "Escape") {
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
      attributeFilter: ["data-theme"],
    });

    terminal.onData((data) => {
      if (statusRef.current !== "connected") {
        const shouldReconnect = shouldReconnectFromInput(
          statusRef.current,
          data,
        );

        if (shouldReconnect && !reconnectRequestedRef.current) {
          reconnectRequestedRef.current = true;
          writeSystemLine(
            formatTerminalNoticeLine(
              t('terminal.notice.reconnectingLabel'),
              t('terminal.notice.reconnectingMessage'),
              "36",
            ),
          );
          onReconnect();
          return;
        }

        if (!inputBlockedNoticeRef.current) {
          writeSystemLine(
            formatTerminalNoticeLine(
              t('terminal.notice.hintLabel'),
              t('terminal.notice.disconnectedHint'),
            ),
          );
          inputBlockedNoticeRef.current = true;
        }
        return;
      }

      invoke("write_session", {
        sessionId: session.sessionId,
        data,
      }).catch((error) => {
        terminalLogger.error("写入会话失败", {
          sessionId: session.sessionId,
          error: String(error),
        });
        inputBlockedNoticeRef.current = true;
        writeSystemLine(
          formatTerminalNoticeLine(
            t('terminal.notice.writeFailedLabel'),
            t('terminal.notice.writeFailedMessage'),
            "31",
          ),
        );
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
        void invoke("resize_session", {
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
      if (
        !force &&
        previousSize &&
        previousSize.width === width &&
        previousSize.height === height
      ) {
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
    window.addEventListener("resize", handleViewportResize);

    return () => {
      terminalLogger.debug("销毁终端实例", { sessionId: session.sessionId });
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleViewportResize);
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
      terminalLogger.warn("非 Tauri 运行时，跳过终端事件监听", {
        sessionId: session.sessionId,
      });
      return;
    }

    let disposeData: UnlistenFn | undefined;
    let disposeStatus: UnlistenFn | undefined;
    let disposeClosed: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      const nextDisposeData = await listen<SshDataEvent>("ssh-data", (event) => {
        if (event.payload.sessionId !== session.sessionId) {
          return;
        }
        if (needsConnectedShellSpacingRef.current) {
          terminalRef.current?.write("\r\n");
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

      const nextDisposeStatus = await listen<SshStatusEvent>("ssh-status", (event) => {
        if (event.payload.sessionId !== session.sessionId) {
          return;
        }
        terminalLogger.info("会话状态更新", event.payload);
        writeSystemLine(formatTerminalStatusLine(event.payload.status, event.payload.message));
        needsConnectedShellSpacingRef.current = event.payload.status === "connected";
      });

      if (cancelled) {
        nextDisposeStatus();
        return;
      }
      disposeStatus = nextDisposeStatus;

      const nextDisposeClosed = await listen<SshClosedEvent>("ssh-closed", (event) => {
        if (event.payload.sessionId !== session.sessionId) {
          return;
        }
        if (shouldWarnOnClosedSession(statusRef.current)) {
          terminalLogger.warn("会话关闭事件", event.payload);
        } else {
          terminalLogger.debug("会话关闭事件（错误态已记录）", event.payload);
        }
        writeSystemLine(
          formatTerminalNoticeLine(
            t('terminal.notice.closedLabel'),
            event.payload.reason ? `: ${event.payload.reason}` : undefined,
            "31",
          ),
        );
        writeSystemLine(
          formatTerminalNoticeLine(
            t('terminal.notice.hintLabel'),
            t('terminal.notice.pressEnterReconnect'),
          ),
        );
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

  const performSearch = (direction: "next" | "previous") => {
    const addon = searchAddonRef.current;
    if (!addon || !searchTerm) {
      return;
    }
    const options = { caseSensitive };
    if (direction === "next") {
      addon.findNext(searchTerm, options);
    } else {
      addon.findPrevious(searchTerm, options);
    }
  };

  const closeSearch = () => {
    searchAddonRef.current?.clearDecorations?.();
    setShowSearch(false);
    setSearchTerm("");
    terminalRef.current?.focus();
  };

  return (
    <section
      className={cn(
        "absolute inset-0 flex flex-col",
        active ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      {showSearch && (
        <div className="absolute right-2 top-2 z-30 flex items-center gap-1.5 rounded-lg p-1.5 backdrop-blur-sm"
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
              if (e.key === "Enter") {
                e.preventDefault();
                performSearch(e.shiftKey ? "previous" : "next");
              }
              if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
            }}
          />
          <button
            className="icon-btn h-6 w-6 px-0 text-xs"
            onClick={() => performSearch("previous")}
            title={t('terminal.search.previous')}
            type="button"
          >
            ↑
          </button>
          <button
            className="icon-btn h-6 w-6 px-0 text-xs"
            onClick={() => performSearch("next")}
            title={t('terminal.search.next')}
            type="button"
          >
            ↓
          </button>
          <button
            className={cn("icon-btn h-6 w-6 px-0 text-xs", caseSensitive && "bg-cyan-500/20 text-cyan-300")}
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
          <button
            className="icon-btn h-6 w-6 px-0 text-xs"
            onClick={closeSearch}
            title={t('terminal.search.close')}
            type="button"
          >
            ✕
          </button>
        </div>
      )}
      <div
        className="terminal-shell themed-terminal-shell min-h-0 flex-1 overflow-hidden"
        ref={shellRef}
      />
    </section>
  );
}
