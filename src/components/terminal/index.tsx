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
import {
  invokeClearTerminalWorkspace,
  invokeSaveTerminalWorkspace,
} from '@/lib/tauri';
import { serializeTerminalWorkspace } from '@/lib/terminal-workspace';
import { createLogger } from '@/lib/logger';

const logger = createLogger('terminalWorkspace');

const Terminal: React.FC = () => {
  const { t } = useI18n();
  const sessions = useTerminalStore((s) => s.sessions);
  const activeSessionId = useTerminalStore((s) => s.activeSessionId);
  const activeSession =
    sessions.find((s) => s.sessionId === activeSessionId) ?? null;
  const restoreWorkspace = useAppStore((s) => s.restoreWorkspace);

  const { connect, openLocal, hostKeyDialog, closeHostKeyDialog } = useConnectSession();

  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    session: TerminalSession;
    x: number;
    y: number;
  } | null>(null);

  const activeSection = useAppStore((s) => s.activeSection);

  useEffect(() => {
    if (!restoreWorkspace) {
      void invokeClearTerminalWorkspace().catch((error) => {
        logger.error('failed to clear terminal workspace', error);
      });
    }
  }, [restoreWorkspace]);

  useEffect(() => {
    if (!restoreWorkspace) return;
    const timer = window.setTimeout(() => {
      void invokeSaveTerminalWorkspace(serializeTerminalWorkspace(sessions)).catch((error) => {
        logger.error('failed to save terminal workspace', error);
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [restoreWorkspace, sessions]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (activeSection !== 'terminal') return;
        event.preventDefault();
        if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
        setNewTabMenuOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeSection]);

  useEffect(() => {
    const handleNewTabRequest = (): void => setNewTabMenuOpen(true);
    document.addEventListener('termbridge:new-terminal-tab', handleNewTabRequest);
    return () => document.removeEventListener('termbridge:new-terminal-tab', handleNewTabRequest);
  }, []);

  return (
    <div className="flex h-full flex-col bg-app-bg">
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
        <NewTabMenu
          open={newTabMenuOpen}
          onClose={() => setNewTabMenuOpen(false)}
          onConnect={connect}
          onOpenLocal={openLocal}
        />
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
