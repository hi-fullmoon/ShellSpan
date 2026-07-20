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
    const currentIds = new Set(sessions.map((s) => s.sessionId));
    for (const sessionId of currentIds) {
      if (!knownRef.current.has(sessionId) && !terminalRegistry.get(sessionId)) {
        terminalRegistry.create(
          sessionId,
          setStatus,
          setClosed,
          (currentSessionId) =>
            useTerminalStore.getState().sessions.find((s) => s.sessionId === currentSessionId,
            )?.status ?? 'connecting',
          (currentSessionId) => reconnectSession(currentSessionId),
        );
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
