import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { t } from '../lib/i18n';
import { createLogger } from '../lib/logger';
import { isTauriRuntime } from '../lib/tauri';
import { createSessionFromProfile } from '../lib/sessionCreate';
import { applyStatusToSessions, consumeBufferedSessionStatus, insertSessionAfterActive, type PendingSessionStatusEvents } from '../lib/session';
import { shouldWarnOnClosedSession } from '../lib/terminal';
import type { SessionState, SshClosedEvent, SshStatusEvent } from '../types';

const sessionsLogger = createLogger('app');

export interface UseSessionsOptions {
  autoReconnect: boolean;
  setErrorMessage: (message: string | undefined) => void;
  removeFileManagerSessionState: (sessionId: string) => void;
  replaceFileManagerSessionStateKey: (oldKey: string, newKey: string) => void;
}

export interface UseSessionsResult {
  sessions: SessionState[];
  setSessions: Dispatch<SetStateAction<SessionState[]>>;
  activeSessionId: string | undefined;
  setActiveSessionId: Dispatch<SetStateAction<string | undefined>>;
  sessionsRef: React.MutableRefObject<SessionState[]>;
  pendingStatusEventsRef: React.MutableRefObject<PendingSessionStatusEvents>;
  autoReconnectAttemptedRef: React.MutableRefObject<Record<string, true>>;
  handleCloseSession: (sessionId: string) => Promise<void>;
  handleReconnectSession: (sessionId: string, options?: { automatic?: boolean }) => Promise<void>;
}

export function useSessions({
  autoReconnect,
  setErrorMessage,
  removeFileManagerSessionState,
  replaceFileManagerSessionStateKey,
}: UseSessionsOptions): UseSessionsResult {
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const pendingStatusEventsRef = useRef<PendingSessionStatusEvents>({});
  const sessionsRef = useRef<SessionState[]>([]);
  const autoReconnectAttemptedRef = useRef<Record<string, true>>({});

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const handleCloseSession = async (sessionId: string) => {
    delete pendingStatusEventsRef.current[sessionId];

    if (!isTauriRuntime()) {
      sessionsLogger.warn('浏览器预览模式下关闭会话', { sessionId });
      setSessions((current) => current.filter((session) => session.sessionId !== sessionId));
      removeFileManagerSessionState(sessionId);
      return;
    }

    try {
      sessionsLogger.info('请求关闭会话', { sessionId });
      await invoke('close_session', { sessionId });
    } finally {
      if (isTauriRuntime()) {
        const forwardOpId = `pf-${sessionId}`;
        void invoke('stop_port_forwards', { operationId: forwardOpId }).catch((error) => {
          sessionsLogger.warn('Failed to stop port forwards', { error: String(error) });
        });
      }
      let nextActiveSessionId: string | undefined;
      setSessions((current) => {
        const remaining = current.filter((session) => session.sessionId !== sessionId);
        nextActiveSessionId = remaining[0]?.sessionId;
        return remaining;
      });
      setActiveSessionId((current) => (current === sessionId ? nextActiveSessionId : current));
      removeFileManagerSessionState(sessionId);
      sessionsLogger.info('会话已从前端状态移除', { sessionId });
    }
  };

  const handleReconnectSession = async (sessionId: string, options?: { automatic?: boolean }) => {
    const automatic = options?.automatic ?? false;
    const target = sessionsRef.current.find((item) => item.sessionId === sessionId);
    if (!target) {
      return;
    }

    if (!isTauriRuntime()) {
      sessionsLogger.warn('浏览器预览模式下尝试重连会话', { sessionId });
      setErrorMessage(t('app.error.desktopOnly'));
      return;
    }

    try {
      sessionsLogger.info('开始重连会话', { sessionId });
      const summary = await createSessionFromProfile(target.profile);
      setSessions((current) => {
        const bufferedStatus = consumeBufferedSessionStatus(summary.sessionId, pendingStatusEventsRef.current);
        const nextSession: SessionState = {
          ...summary,
          title: target.title,
          profile: target.profile,
          status: bufferedStatus?.status ?? 'connecting',
          note: bufferedStatus?.note,
          createdAt: Date.now(),
        };
        return current.map((item) => (item.sessionId === sessionId ? nextSession : item));
      });
      setActiveSessionId((current) => (current === sessionId ? summary.sessionId : current));
      replaceFileManagerSessionStateKey(sessionId, summary.sessionId);
      delete autoReconnectAttemptedRef.current[sessionId];
      delete autoReconnectAttemptedRef.current[summary.sessionId];
      setErrorMessage(undefined);
      sessionsLogger.info('会话重连成功', {
        fromSessionId: sessionId,
        toSessionId: summary.sessionId,
        automatic,
      });
    } catch (error) {
      sessionsLogger.error('会话重连失败', {
        sessionId,
        automatic,
        error: String(error),
      });
      setSessions((current) =>
        current.map((item) =>
          item.sessionId === sessionId
            ? {
                ...item,
                status: 'error',
                note: automatic
                  ? t('app.error.autoReconnectFailed', { error: String(error) })
                  : t('app.error.reconnectFailed', { error: String(error) }),
              }
            : item,
        ),
      );
      setErrorMessage(
        automatic ? t('app.error.autoReconnectFailed', { error: String(error) }) : t('app.error.reconnectFailed', { error: String(error) }),
      );
    }
  };

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let stopStatus: UnlistenFn | undefined;
    let stopClosed: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      const nextStopStatus = await listen<SshStatusEvent>('ssh-status', (event) => {
        sessionsLogger.debug('收到会话状态事件', event.payload);
        setSessions((current) => applyStatusToSessions(current, event.payload, pendingStatusEventsRef.current));
      });

      if (cancelled) {
        nextStopStatus();
        return;
      }
      stopStatus = nextStopStatus;

      const nextStopClosed = await listen<SshClosedEvent>('ssh-closed', (event) => {
        // Stop port forwards when session closes
        if (isTauriRuntime()) {
          const forwardOpId = `pf-${event.payload.sessionId}`;
          void invoke('stop_port_forwards', { operationId: forwardOpId }).catch(() => {
            /* port forwards may not have been started */
          });
        }

        const currentSession = sessionsRef.current.find((session) => session.sessionId === event.payload.sessionId);
        const shouldAutoReconnect =
          !!currentSession &&
          autoReconnect &&
          event.payload.reasonKind === 'transport_disconnect' &&
          event.payload.retryable &&
          !autoReconnectAttemptedRef.current[event.payload.sessionId];

        if (currentSession) {
          if (shouldWarnOnClosedSession(currentSession.status)) {
            sessionsLogger.warn('会话已关闭', event.payload);
          } else {
            sessionsLogger.debug('会话关闭事件（错误态已记录）', event.payload);
          }
        }

        if (shouldAutoReconnect) {
          autoReconnectAttemptedRef.current[event.payload.sessionId] = true;
        }

        setSessions((current) =>
          current.map((session) => {
            if (session.sessionId !== event.payload.sessionId) {
              return session;
            }

            return {
              ...session,
              status: shouldAutoReconnect ? 'connecting' : session.status === 'error' ? 'error' : 'disconnected',
              note: shouldAutoReconnect ? t('app.note.autoReconnecting') : event.payload.reason,
            };
          }),
        );

        if (shouldAutoReconnect) {
          void handleReconnectSession(event.payload.sessionId, { automatic: true });
        }
      });

      if (cancelled) {
        nextStopClosed();
        return;
      }
      stopClosed = nextStopClosed;
    };

    void attach();

    return () => {
      cancelled = true;
      stopStatus?.();
      stopClosed?.();
    };
  }, [autoReconnect]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    sessions,
    setSessions,
    activeSessionId,
    setActiveSessionId,
    sessionsRef,
    pendingStatusEventsRef,
    autoReconnectAttemptedRef,
    handleCloseSession,
    handleReconnectSession,
  };
}
