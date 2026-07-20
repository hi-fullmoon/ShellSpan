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
  const terminalCursorBlink = useAppStore((s) => s.terminalCursorBlink);
  const terminalScrollback = useAppStore((s) => s.terminalScrollback);
  const knownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    terminalRegistry.updateOptions({
      fontSize: terminalFontSize,
      cursorBlink: terminalCursorBlink,
      scrollback: terminalScrollback,
    });
  }, [terminalCursorBlink, terminalFontSize, terminalScrollback]);

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
