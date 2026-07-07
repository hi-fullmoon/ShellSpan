import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { invokeCloseSession } from '@/lib/tauri';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';

export const TerminalTabBar: React.FC = () => {
  const { t } = useI18n();
  const sessions = useTerminalStore((state) => state.sessions);
  const activeSessionId = useTerminalStore((state) => state.activeSessionId);
  const setActiveSession = useTerminalStore((state) => state.setActiveSession);
  const removeSession = useTerminalStore((state) => state.removeSession);
  const setActiveSection = useAppStore((state) => state.setActiveSection);

  const handleCloseSession = (sessionId: string): void => {
    removeSession(sessionId);
    invokeCloseSession(sessionId).catch(() => {
      // Ignore close errors after the tab is dismissed locally.
    });
  };

  return (
    <div className="flex h-9 items-center gap-1 border-b border-app-border bg-app-surface-muted px-2">
      {sessions.map((session) => (
        <button
          key={session.sessionId}
          onClick={() => setActiveSession(session.sessionId)}
          className={cn(
            'group flex h-7 max-w-40 items-center gap-2 rounded-lg px-2.5 text-xs transition-colors',
            activeSessionId === session.sessionId
              ? 'bg-app-surface text-app-text shadow-sm'
              : 'text-app-text-soft hover:bg-app-surface/50 hover:text-app-text',
          )}
        >
          <span className="truncate">{session.title}</span>
          {session.status === 'error' && (
            <span className="h-1.5 w-1.5 rounded-full bg-app-error" />
          )}
          <span
            onClick={(e) => {
              e.stopPropagation();
              handleCloseSession(session.sessionId);
            }}
            className="hidden h-4 w-4 items-center justify-center rounded hover:bg-app-border group-hover:flex"
          >
            ×
          </span>
        </button>
      ))}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setActiveSection('workbench')}
        className="ml-auto"
      >
        + {t('terminal.newTab')}
      </Button>
    </div>
  );
};
