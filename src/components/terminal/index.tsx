import React, { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { useConnectSession } from '@/hooks/useConnectSession';
import { TerminalControllerLayer } from './terminal-controller-layer';
import { TerminalTabBar } from './terminal-tab-bar';
import { TerminalPane } from './terminal-pane';
import { NewTabMenu } from './new-tab-menu';
import { TerminalContextMenu } from './terminal-context-menu';
import { HostKeyDialog } from './host-key-dialog';

const Terminal: React.FC = () => {
  const { t } = useI18n();
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const activeSession =
    sessions.find((s) => s.sessionId === activeSessionId) ?? null;

  const { hostKeyDialog, closeHostKeyDialog } = useConnectSession();

  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    session: TerminalSession;
    x: number;
    y: number;
  } | null>(null);

  const activeSection = useAppStore((s) => s.activeSection);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (activeSection !== 'terminal') return;
        event.preventDefault();
        setNewTabMenuOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeSection]);

  return (
    <div className="flex h-full flex-col">
      <TerminalControllerLayer />
      {sessions.length > 0 && (
        <TerminalTabBar
          onNewTabClick={() => setNewTabMenuOpen(true)}
          onTabContextMenu={(session, x, y) =>
            setContextMenu({ session, x, y })
          }
        />
      )}
      <div className="relative min-h-0 flex-1">
        {sessions.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              title={t('terminal.empty')}
              description={t('terminal.openFromWorkbench')}
              action={
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setNewTabMenuOpen(true)}
                >
                  {t('terminal.empty.newConnection')}
                </Button>
              }
            />
          </div>
        ) : (
          <TerminalPane activeSession={activeSession} />
        )}
        <NewTabMenu open={newTabMenuOpen} onClose={() => setNewTabMenuOpen(false)} />
      </div>
      <TerminalContextMenu
        open={!!contextMenu}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        session={contextMenu?.session ?? null}
        onClose={() => setContextMenu(null)}
      />
      <HostKeyDialog
        open={hostKeyDialog.open}
        onClose={closeHostKeyDialog}
        host={hostKeyDialog.host}
        port={hostKeyDialog.port}
        fingerprint={hostKeyDialog.fingerprint}
        mismatch={hostKeyDialog.mismatch}
        onTrust={hostKeyDialog.onTrust}
      />
    </div>
  );
};

export default Terminal;
