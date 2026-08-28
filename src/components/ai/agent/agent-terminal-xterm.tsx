import '@xterm/xterm/css/xterm.css';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
  resolveTerminalFontFamily,
  resolveTerminalTheme,
} from '@/components/terminal/registry/terminal-registry';
import {
  invokeMarkSessionReady,
  invokeResizeSession,
  listenToSshClosed,
  listenToSshData,
  listenToSshStatus,
} from '@/lib/tauri';
import { useAppStore } from '@/stores/appStore';

export interface AgentTerminalXtermHandleV1 {
  focus: () => void;
}

export const AgentTerminalXtermV1 = forwardRef<AgentTerminalXtermHandleV1, {
  sessionId: string;
  disabled: boolean;
  ariaLabel: string;
  onData: (data: string) => void;
  onTransportHint: (hint: string) => void;
}>(function AgentTerminalXtermV1({
  sessionId,
  disabled,
  ariaLabel,
  onData,
  onTransportHint,
}, forwardedRef) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const onDataRef = useRef(onData);
  const onTransportHintRef = useRef(onTransportHint);
  const fontSize = useAppStore((state) => state.terminalFontSize);
  const fontFamily = useAppStore((state) => state.terminalFontFamily);
  const cursorBlink = useAppStore((state) => state.terminalCursorBlink);
  const cursorStyle = useAppStore((state) => state.terminalCursorStyle);
  const scrollback = useAppStore((state) => state.terminalScrollback);
  const colorScheme = useAppStore((state) => state.terminalColorScheme);
  const lineHeight = useAppStore((state) => state.terminalLineHeight);
  const letterSpacing = useAppStore((state) => state.terminalLetterSpacing);

  onDataRef.current = onData;
  onTransportHintRef.current = onTransportHint;

  useImperativeHandle(forwardedRef, () => ({
    focus: () => terminalRef.current?.focus(),
  }), []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const terminal = new Terminal({
      fontFamily: resolveTerminalFontFamily(fontFamily),
      fontSize,
      theme: resolveTerminalTheme(colorScheme),
      cursorBlink,
      cursorStyle,
      scrollback,
      lineHeight,
      letterSpacing,
      disableStdin: disabled,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const inputDisposable = terminal.onData((data) => {
      // The raw data is deliberately handed straight to the narrow takeover
      // callback. It is never copied into component or store state.
      onDataRef.current(data);
    });
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void Promise.all([
      listenToSshData(sessionId, (event) => {
        if (!disposed) terminal.write(event.payload);
      }),
      listenToSshStatus(sessionId, (event) => {
        if (!disposed) onTransportHintRef.current(event.payload.status);
      }),
      listenToSshClosed(sessionId, () => {
        if (!disposed) onTransportHintRef.current('disconnected');
      }),
    ]).then((nextUnlisteners) => {
      if (disposed) {
        nextUnlisteners.forEach((unlisten) => unlisten());
      } else {
        unlisteners.push(...nextUnlisteners);
        void invokeMarkSessionReady(sessionId).catch(() => {});
      }
    }).catch(() => {
      if (!disposed) onTransportHintRef.current('listenerFailed');
    });

    const sendResize = (): void => {
      try {
        fitAddon.fit();
        void invokeResizeSession(sessionId, terminal.cols, terminal.rows).catch(() => {});
      } catch {
        // A hidden or tearing-down panel may not have measurable dimensions.
      }
    };
    const resizeObserver = new ResizeObserver(sendResize);
    resizeObserver.observe(host);
    sendResize();

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      inputDisposable.dispose();
      unlisteners.forEach((unlisten) => unlisten());
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      host.replaceChildren();
    };
    // The display settings below are updated without reconstructing xterm.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = disabled;
  }, [disabled]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = fontSize;
    terminal.options.fontFamily = resolveTerminalFontFamily(fontFamily);
    terminal.options.cursorBlink = cursorBlink;
    terminal.options.cursorStyle = cursorStyle;
    terminal.options.scrollback = scrollback;
    terminal.options.theme = resolveTerminalTheme(colorScheme);
    terminal.options.lineHeight = lineHeight;
    terminal.options.letterSpacing = letterSpacing;
    try {
      fitAddonRef.current?.fit();
    } catch {
      // Hidden panels can be temporarily unmeasurable.
    }
  }, [
    colorScheme,
    cursorBlink,
    cursorStyle,
    fontFamily,
    fontSize,
    letterSpacing,
    lineHeight,
    scrollback,
  ]);

  return (
    <div
      ref={hostRef}
      data-testid="agent-terminal-xterm"
      aria-label={ariaLabel}
      className="h-full min-h-48 w-full overflow-hidden rounded-md bg-background [&>.terminal.xterm]:h-full [&>.terminal.xterm]:p-2"
    />
  );
});
