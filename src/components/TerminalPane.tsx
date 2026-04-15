import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { createLogger } from "../lib/logger";
import { isTauriRuntime } from "../lib/tauri";
import {
  shouldDisableTerminalInput,
  shouldReconnectFromInput,
  shouldWarnOnClosedSession,
} from "../lib/terminalStatus";
import { cn } from "../lib/ui";
import type {
  SessionState,
  SessionStatus,
  SshClosedEvent,
  SshDataEvent,
  SshStatusEvent,
} from "../types";

interface TerminalPaneProps {
  session: SessionState;
  active: boolean;
  onReconnect: () => void;
}

const terminalLogger = createLogger("terminal");

function statusLabel(status: SessionStatus) {
  switch (status) {
    case "connected":
      return "已连接";
    case "connecting":
      return "连接中";
    case "error":
      return "错误";
    case "disconnected":
      return "已断开";
  }
}

export function TerminalPane({ session, active, onReconnect }: TerminalPaneProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  const statusRef = useRef(session.status);
  const inputBlockedNoticeRef = useRef(false);
  const reconnectRequestedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const pendingResizeSyncRef = useRef<number | null>(null);
  const lastShellSizeRef = useRef<{ width: number; height: number } | null>(null);
  const scheduleResizeRef = useRef<((force?: boolean) => void) | null>(null);

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
    if (!shellRef.current || terminalRef.current) {
      return;
    }

    terminalLogger.info("初始化终端面板", { sessionId: session.sessionId });

    const terminal = new Terminal({
      cursorBlink: true,
      allowProposedApi: true,
      convertEol: true,
      fontFamily:
        '"JetBrains Mono", "SF Mono", "Cascadia Code", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.25,
      theme: {
        background: "#020617",
        foreground: "#dbe7f5",
        cursor: "#67e8f9",
        selectionBackground: "#1e293b",
        black: "#0f172a",
        brightBlack: "#475569",
        red: "#fb7185",
        green: "#34d399",
        yellow: "#fbbf24",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#67e8f9",
        white: "#e2e8f0",
        brightWhite: "#f8fafc",
      },
      scrollback: 5000,
      disableStdin: shouldDisableTerminalInput(session.status),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
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
    terminal.writeln("\u001b[36m[termbridge]\u001b[0m 终端准备中...");
    terminal.onData((data) => {
      if (statusRef.current !== "connected") {
        const shouldReconnect = shouldReconnectFromInput(
          statusRef.current,
          data,
        );

        if (shouldReconnect && !reconnectRequestedRef.current) {
          reconnectRequestedRef.current = true;
          terminal.writeln("\r\n\u001b[36m[重连中]\u001b[0m 正在重新连接...");
          onReconnect();
          return;
        }

        if (!inputBlockedNoticeRef.current) {
          terminal.writeln(
            "\r\n\u001b[33m[提示]\u001b[0m 当前连接已断开，按回车重连。",
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
        terminal.writeln(
          `\r\n\u001b[31m[写入失败]\u001b[0m 连接不可用，请重连后再试。`,
        );
      });
    });

    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    lastShellSizeRef.current = null;

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
    const observer = new ResizeObserver(handleViewportResize);
    observer.observe(shellRef.current);
    window.addEventListener("resize", handleViewportResize);

    return () => {
      terminalLogger.debug("销毁终端实例", { sessionId: session.sessionId });
      observer.disconnect();
      window.removeEventListener("resize", handleViewportResize);
      scheduleResizeRef.current = null;
      clearPendingResizeSync();
      lastShellSizeRef.current = null;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
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
        terminalRef.current?.write(event.payload.chunk);
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
        const message = event.payload.message
          ? `: ${event.payload.message}`
          : "";
        terminalRef.current?.writeln(
          `\r\n\u001b[33m[${
            statusLabel(event.payload.status)
          }]\u001b[0m${message}`,
        );
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
        const reason = event.payload.reason ? `: ${event.payload.reason}` : "";
        terminalRef.current?.writeln(
          `\r\n\u001b[31m[已关闭]\u001b[0m${reason}`,
        );
        terminalRef.current?.writeln(
          "\u001b[33m[提示]\u001b[0m 按回车重连。",
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

  return (
    <section
      className={cn(
        "absolute inset-0 flex flex-col",
        active ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <div
        className="terminal-shell min-h-0 flex-1 overflow-hidden bg-slate-950"
        ref={shellRef}
      />
    </section>
  );
}
