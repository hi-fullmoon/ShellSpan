import React, { useEffect, useRef } from 'react';
import { useTerminalStore } from '@/stores/terminalStore';
import { useReconnectSession } from '@/hooks/useReconnectSession';
import { terminalRegistry } from './registry/terminal-registry';
import { useAppStore } from '@/stores/appStore';

export const TerminalControllerLayer: React.FC = () => {
  const sessions = useTerminalStore((s) => s.sessions);
  const setStatus = useTerminalStore((s) => s.setStatus);
  const setClosed = useTerminalStore((s) => s.setClosed);
  const reconnectSession = useReconnectSession();
  const terminalFontSize = useAppStore((s) => s.terminalFontSize);
  const terminalFontFamily = useAppStore((s) => s.terminalFontFamily);
  const terminalCursorBlink = useAppStore((s) => s.terminalCursorBlink);
  const terminalCursorStyle = useAppStore((s) => s.terminalCursorStyle);
  const terminalScrollback = useAppStore((s) => s.terminalScrollback);
  const terminalColorScheme = useAppStore((s) => s.terminalColorScheme);
  const terminalAutoReconnect = useAppStore((s) => s.terminalAutoReconnect);
  const terminalLineHeight = useAppStore((s) => s.terminalLineHeight);
  const terminalLetterSpacing = useAppStore((s) => s.terminalLetterSpacing);
  const terminalUrlDetection = useAppStore((s) => s.terminalUrlDetection);
  const terminalBellStyle = useAppStore((s) => s.terminalBellStyle);
  const knownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    terminalRegistry.updateOptions({
      fontSize: terminalFontSize,
      fontFamily: terminalFontFamily,
      cursorBlink: terminalCursorBlink,
      cursorStyle: terminalCursorStyle,
      scrollback: terminalScrollback,
      colorScheme: terminalColorScheme,
      autoReconnect: terminalAutoReconnect,
      lineHeight: terminalLineHeight,
      letterSpacing: terminalLetterSpacing,
      urlDetection: terminalUrlDetection,
      bellStyle: terminalBellStyle,
    });
  }, [terminalAutoReconnect, terminalBellStyle, terminalColorScheme, terminalCursorBlink, terminalCursorStyle, terminalFontFamily, terminalFontSize, terminalLetterSpacing, terminalLineHeight, terminalScrollback, terminalUrlDetection]);

  useEffect(() => {
    const root = document.documentElement;
    let previousTheme = root.getAttribute('data-theme');
    const observer = new MutationObserver(() => {
      const nextTheme = root.getAttribute('data-theme');
      if (nextTheme === previousTheme) return;
      previousTheme = nextTheme;
      terminalRegistry.refreshTheme();
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.sessionId));
    for (const session of sessions) {
      if (!knownRef.current.has(session.sessionId) && !terminalRegistry.get(session.sessionId)) {
        const controller = terminalRegistry.create(
          session.sessionId,
          setStatus,
          setClosed,
          (currentSessionId) =>
            useTerminalStore.getState().sessions.find((s) => s.sessionId === currentSessionId,
            )?.status ?? 'connecting',
          (currentSessionId) => reconnectSession(currentSessionId),
        );
        // Restored workspace sessions start disconnected and have no backend
        // process, so the closed-event hint never fires for them; show it up
        // front so the pane isn't blank.
        if (session.status === 'disconnected') {
          controller.writeDisconnectedHint();
        }
      }
    }
    for (const sessionId of knownRef.current) {
      if (!currentIds.has(sessionId)) {
        terminalRegistry.dispose(sessionId);
      }
    }
    knownRef.current = currentIds;
  }, [sessions, setStatus, setClosed, reconnectSession]);

  return null;
};
