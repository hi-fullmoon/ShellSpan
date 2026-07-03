import { useMemo, useRef } from 'react';
import { SessionTabs } from './SessionTabs';
import { TerminalPane, type TerminalPaneRef } from './TerminalPane';
import { cn, sessionStatusTone } from '../lib/ui';
import { t } from '../lib/i18n';
import type { SessionState, TerminalTheme, CursorStyle } from '../types';

interface TerminalSectionProps {
  sessions: SessionState[];
  activeSessionId?: string;
  errorMessage?: string;
  preferences: {
    terminalFontSize: number;
    terminalLineHeight: number;
    terminalTheme: TerminalTheme;
    cursorStyle: CursorStyle;
    cursorBlink: boolean;
    copyOnSelect: boolean;
  };
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  onCloseAllSessions: () => void;
  onCloseOtherSessions: (sessionId: string) => void;
  onCloseSessionsToLeft: (sessionId: string) => void;
  onCloseSessionsToRight: (sessionId: string) => void;
  onReorderSessions: (draggedSessionId: string, insertIndex: number) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onSetSessionColor: (sessionId: string, color?: string) => void;
  onToggleSessionPin: (sessionId: string) => void;
  onReconnectSession: (sessionId: string) => void;
  onNewConnection: () => void;
}

export function TerminalSection({
  sessions,
  activeSessionId,
  errorMessage,
  preferences,
  onSelectSession,
  onCloseSession,
  onCloseAllSessions,
  onCloseOtherSessions,
  onCloseSessionsToLeft,
  onCloseSessionsToRight,
  onReorderSessions,
  onRenameSession,
  onSetSessionColor,
  onToggleSessionPin,
  onReconnectSession,
  onNewConnection,
}: TerminalSectionProps) {
  const terminalPaneRefs = useRef<Record<string, TerminalPaneRef>>({});

  const activeSession = useMemo(
    () => sessions.find((item) => item.sessionId === activeSessionId),
    [activeSessionId, sessions],
  );

  return (
    <section className="flex h-full w-full min-h-0 min-w-0 flex-col">
      {errorMessage ? (
        <div className="surface flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-rose-300">
          <span className="truncate">{errorMessage}</span>
          {activeSession ? (
            <span className={cn('px-2 py-1 text-[10px]', sessionStatusTone(activeSession.status))}>
              {activeSession.status === 'connected'
                ? t('app.status.connected')
                : activeSession.status === 'connecting'
                  ? t('app.status.connecting')
                  : activeSession.status === 'error'
                    ? t('app.status.error')
                    : t('app.status.disconnected')}
            </span>
          ) : null}
        </div>
      ) : null}

      <SessionTabs
        sessions={sessions}
        activeSessionId={activeSessionId}
        onClose={onCloseSession}
        onCloseAll={onCloseAllSessions}
        onCloseOthers={onCloseOtherSessions}
        onCloseToLeft={onCloseSessionsToLeft}
        onCloseToRight={onCloseSessionsToRight}
        onNewConnection={onNewConnection}
        onReorder={onReorderSessions}
        onRename={onRenameSession}
        onSelect={onSelectSession}
        onSetColor={onSetSessionColor}
        onTogglePin={onToggleSessionPin}
      />

      <section className="surface relative min-h-0 flex-1 overflow-hidden">
        {sessions.length === 0 ? (
          <div className="flex h-full min-h-70 flex-col items-center justify-center gap-2 p-1.5 text-center">
            <span className="label">{t('terminal.empty.title')}</span>
            <h3 className="themed-heading text-base font-semibold">{t('terminal.empty.title')}</h3>
            <p className="text-xs leading-5 text-slate-400">{t('terminal.empty.description')}</p>
          </div>
        ) : (
          <div className="relative h-full min-h-0">
            {sessions.map((session) => (
              <TerminalPane
                active={session.sessionId === activeSessionId}
                copyOnSelect={preferences.copyOnSelect}
                cursorBlink={preferences.cursorBlink}
                cursorStyle={preferences.cursorStyle}
                fontSize={preferences.terminalFontSize}
                key={session.sessionId}
                lineHeight={preferences.terminalLineHeight}
                onReconnect={() => {
                  void onReconnectSession(session.sessionId);
                }}
                ref={(el) => {
                  if (el) {
                    terminalPaneRefs.current[session.sessionId] = el;
                  } else {
                    delete terminalPaneRefs.current[session.sessionId];
                  }
                }}
                session={session}
                terminalTheme={preferences.terminalTheme}
              />
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
