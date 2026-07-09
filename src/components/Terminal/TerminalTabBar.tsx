import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { invokeCloseSession } from '@/lib/tauri';
import {
  useTerminalStore,
  type TerminalSession,
} from '@/stores/terminalStore';

export interface TerminalTabBarProps {
  onNewTabClick?: () => void;
  onTabContextMenu?: (
    session: TerminalSession,
    x: number,
    y: number,
  ) => void;
}

export const TerminalTabBar: React.FC<TerminalTabBarProps> = ({
  onNewTabClick,
  onTabContextMenu,
}) => {
  const { t } = useI18n();
  const sessions = useTerminalStore((state) => state.sessions);
  const activeSessionId = useTerminalStore((state) => state.activeSessionId);
  const setActiveSession = useTerminalStore((state) => state.setActiveSession);
  const removeSession = useTerminalStore((state) => state.removeSession);

  const handleCloseSession = (sessionId: string): void => {
    removeSession(sessionId);
    invokeCloseSession(sessionId).catch(() => {});
  };

  return (
    <div className="flex h-9 items-center gap-1 border-b border-app-border bg-app-surface-muted px-2">
      <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {sessions.map((session) => {
          const active = activeSessionId === session.sessionId;
          return (
            <div
              key={session.sessionId}
              role="tab"
              tabIndex={0}
              onClick={() => setActiveSession(session.sessionId)}
              onContextMenu={(e) => {
                e.preventDefault();
                onTabContextMenu?.(session, e.clientX, e.clientY);
              }}
              className={cn(
                'group relative flex h-7 max-w-44 min-w-24 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors cursor-pointer',
                active
                  ? 'text-app-text'
                  : 'text-app-text-soft hover:bg-app-surface/50 hover:text-app-text',
              )}
            >
              {active && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-app-primary" />
              )}
              {session.status === 'error' && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-app-error" />
              )}
              <span className="flex-1 truncate text-center">{session.title}</span>
              <button
                type="button"
                aria-label="close"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseSession(session.sessionId);
                }}
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-app-border',
                  active ? 'flex' : 'hidden group-hover:flex',
                )}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onNewTabClick}
        title={t('terminal.newTab')}
        className="ml-auto"
      >
        +
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title="Split"
        className="hidden"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="8" y1="3" x2="8" y2="21" />
          <path d="M3 7l5-4 5 4" />
          <path d="M3 17l5 4 5-4" />
        </svg>
      </Button>
    </div>
  );
};
