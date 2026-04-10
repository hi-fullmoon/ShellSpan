import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { isTauriRuntime } from "../lib/tauri";
import { cn, sessionStatusTone } from "../lib/ui";
import { RefreshIcon } from "./Icons";
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
      terminalRef.current.options.disableStdin = session.status !== "connected";
    }
    if (session.status === "connected") {
      inputBlockedNoticeRef.current = false;
    }
  }, [session.status]);

  useEffect(() => {
    if (!shellRef.current || terminalRef.current) {
      return;
    }

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
      disableStdin: session.status !== "connected",
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(shellRef.current);
    fitAddon.fit();
    terminal.writeln("\u001b[36m[termbridge]\u001b[0m 终端准备中...");
    terminal.onData((data) => {
      if (statusRef.current !== "connected") {
        if (!inputBlockedNoticeRef.current) {
          terminal.writeln("\r\n\u001b[33m[提示]\u001b[0m 当前连接已断开，请先重连。");
          inputBlockedNoticeRef.current = true;
        }
        return;
      }

      invoke("write_session", {
        sessionId: session.sessionId,
        data,
      }).catch((error) => {
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
        const reason = event.payload.reason ? `: ${event.payload.reason}` : "";
        terminalRef.current?.writeln(
          `\r\n\u001b[31m[已关闭]\u001b[0m${reason}`,
        );
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
      <header className="flex items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/95 px-2 py-1">
        <div className="min-w-0">
          <strong className="block truncate text-sm text-slate-100">{session.title}</strong>
          <span className="block truncate text-xs text-slate-400">
            {session.username}@{session.host}:{session.port}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {session.status === "disconnected" || session.status === "error" ? (
            <button
              className="icon-btn h-7 gap-1 px-2"
              onClick={onReconnect}
              type="button"
            >
              <RefreshIcon />
              重连
            </button>
          ) : null}
          <span className={cn("rounded-md px-2 py-1 text-[11px]", sessionStatusTone(session.status))}>
            {statusLabel(session.status)}
          </span>
        </div>
      </header>
      <div
        className="terminal-shell min-h-0 flex-1 overflow-hidden bg-slate-950"
        ref={shellRef}
      />
    </section>
  );
}
