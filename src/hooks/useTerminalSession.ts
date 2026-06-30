import { useCallback, useEffect, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { createLogger } from '../lib/logger';
import { isTauriRuntime } from '../lib/tauri';
import {
  formatTerminalNoticeLine,
  formatTerminalStatusLine,
  shouldReconnectFromInput,
  shouldWarnOnClosedSession,
} from '../lib/terminal';
import { t } from '../lib/i18n';
import type { SessionState, SshClosedEvent, SshDataEvent, SshStatusEvent } from '../types';

const terminalLogger = createLogger('terminal');

export interface UseTerminalSessionOptions {
  terminalRef: React.RefObject<Terminal | null>;
  isAlive: () => boolean;
  session: SessionState;
  onReconnect: () => void;
}

export interface UseTerminalSessionReturn {
  writeToSession: (data: string) => void;
  statusRef: React.RefObject<SessionState['status']>;
}

export function useTerminalSession({
  terminalRef,
  isAlive,
  session,
  onReconnect,
}: UseTerminalSessionOptions): UseTerminalSessionReturn {
  const statusRef = useRef(session.status);
  const inputBlockedNoticeRef = useRef(false);
  const reconnectRequestedRef = useRef(false);
  const needsSystemLineBreakRef = useRef(false);
  const needsConnectedShellSpacingRef = useRef(false);
  const sessionIdRef = useRef(session.sessionId);

  useEffect(() => {
    sessionIdRef.current = session.sessionId;
  }, [session.sessionId]);

  useEffect(() => {
    statusRef.current = session.status;
    if (session.status === 'connected') {
      inputBlockedNoticeRef.current = false;
      reconnectRequestedRef.current = false;
    }
  }, [session.status]);

  const writeSystemLine = useCallback((line: string) => {
    const terminal = terminalRef.current;
    if (!terminal || !isAlive()) {
      return;
    }

    const prefix = needsSystemLineBreakRef.current ? '\r\n' : '';
    terminal.writeln(`${prefix}${line}`);
    needsSystemLineBreakRef.current = false;
  }, [terminalRef, isAlive]);

  const syncSystemLineBreakStateFromChunk = useCallback((chunk: string) => {
    if (!chunk) {
      return;
    }
    needsSystemLineBreakRef.current = !/[\r\n]$/.test(chunk);
  }, []);

  // Centralized write helper used by imperative sendData, paste, and snippets.
  const writeToSession = useCallback(
    (data: string) => {
      const terminal = terminalRef.current;
      if (!terminal || !isAlive()) {
        return;
      }

      if (statusRef.current === 'connected') {
        void invoke('write_session', {
          sessionId: sessionIdRef.current,
          data,
        }).catch((error) => {
          terminalLogger.error('写入会话失败', {
            sessionId: sessionIdRef.current,
            error: String(error),
          });
          inputBlockedNoticeRef.current = true;
          writeSystemLine(formatTerminalNoticeLine(t('terminal.notice.writeFailedLabel'), t('terminal.notice.writeFailedMessage'), '31'));
        });
      } else {
        terminal.write(data);
      }
    },
    [terminalRef, isAlive, writeSystemLine],
  );

  // Bind terminal.onData (user keystrokes).
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !isAlive()) {
      return;
    }

    const disposable = terminal.onData((data) => {
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

      writeToSession(data);
    });

    return () => {
      disposable.dispose();
    };
  }, [terminalRef, onReconnect, writeToSession, writeSystemLine]);

  // Listen to Tauri SSH events.
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
        const terminal = terminalRef.current;
        if (!terminal || !isAlive()) {
          return;
        }
        if (needsConnectedShellSpacingRef.current) {
          terminal.write('\r\n');
          needsConnectedShellSpacingRef.current = false;
        }
        terminal.write(event.payload.chunk);
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
          formatTerminalNoticeLine(
            t('terminal.notice.closedLabel'),
            event.payload.reason ? `: ${event.payload.reason}` : undefined,
            '31',
          ),
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
  }, [session.sessionId, terminalRef, writeSystemLine, syncSystemLineBreakStateFromChunk]);

  return {
    writeToSession,
    statusRef,
  };
}
