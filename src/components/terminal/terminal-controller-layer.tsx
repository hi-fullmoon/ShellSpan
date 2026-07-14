import React, { useEffect, useRef } from 'react';
import { useTerminalStore } from '@/stores/terminalStore';
import { useReconnectSession } from '@/hooks/useReconnectSession';
import { terminalRegistry } from './registry/terminal-registry';

export const TerminalControllerLayer: React.FC = () => {
  const sessions = useTerminalStore((s) => s.sessions);
  const setStatus = useTerminalStore((s) => s.setStatus);
  const setClosed = useTerminalStore((s) => s.setClosed);
  const reconnectSession = useReconnectSession();
  const knownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentIds = new Set(sessions.map((s) => s.sessionId));
    for (const sessionId of currentIds) {
      if (!knownRef.current.has(sessionId)) {
        terminalRegistry.create(
          sessionId,
          setStatus,
          setClosed,
          () =>
            useTerminalStore.getState().sessions.find((s) => s.sessionId === sessionId,
            )?.status ?? 'connecting',
          () => reconnectSession(sessionId),
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
