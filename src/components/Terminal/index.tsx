import React from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useTerminalStore } from '@/stores/terminalStore';
import { EmptyState } from '@/components/ui/EmptyState';
import { TerminalTabBar } from './TerminalTabBar';
import { TerminalSession } from './TerminalSession';

const Terminal: React.FC = () => {
  const { t } = useI18n();
  const sessions = useTerminalStore((state) => state.sessions);
  const activeSessionId = useTerminalStore((state) => state.activeSessionId);
  const activeSession = sessions.find(
    (session) => session.sessionId === activeSessionId,
  );

  return (
    <div className="flex h-full flex-col">
      <TerminalTabBar />
      <div className="flex-1 min-h-0 p-2">
        {sessions.length === 0 && (
          <div className="flex h-full items-center justify-center"
          >
            <EmptyState title={t('terminal.empty')} />
          </div>
        )}
        {activeSession && <TerminalSession session={activeSession} />}
      </div>
    </div>
  );
};

export default Terminal;
