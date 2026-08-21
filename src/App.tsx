import React, { Suspense } from 'react';
import { cn } from '@/lib/utils';
import { AppShell, MainContent } from '@/components/layout/app-shell';
import { useAppStore } from '@/stores/appStore';
import { useTheme } from '@/hooks/useTheme';
import { useI18n } from '@/hooks/useI18n';
import { useDisableContextMenu } from '@/hooks/useDisableContextMenu';
import { Spinner } from '@/components/ui/empty-state';
import { Toaster } from '@/components/ui/sonner';

const Workbench = React.lazy(() => import('@/components/workbench'));
const Terminal = React.lazy(() => import('@/components/terminal'));
const Sftp = React.lazy(() => import('@/components/sftp'));

import { useTransferListeners } from '@/hooks/useTransferListeners';
import { useMonitorEvents } from '@/hooks/useMonitorEvents';
import { useTerminalStore } from '@/stores/terminalStore';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { AboutDialog } from '@/components/about-dialog';
import { UpdateRestartDialog } from '@/components/update-restart-dialog';
import { useUpdateStore } from '@/stores/updateStore';
import { isTauriRuntime } from '@/lib/tauri';
import { shouldRunStartupUpdateCheck } from '@/lib/update';
import { createLogger } from '@/lib/logger';
import { useAppShortcuts } from '@/hooks/useAppShortcuts';
import { CredentialPromptDialog } from '@/components/terminal/credential-prompt-dialog';
import { KeychainKeyPromptDialog } from '@/components/terminal/keychain-key-prompt-dialog';
import { HostKeyDialogHost } from '@/components/terminal/host-key-dialog-host';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { AiPanel } from '@/components/ai/ai-panel';
const logger = createLogger('app');

export const App: React.FC = () => {
  useDisableContextMenu();
  useTheme();
  useTransferListeners();
  useMonitorEvents();
  useAppShortcuts();

  const [aboutDialogOpen, setAboutDialogOpen] = React.useState(false);
  const [exitDialogOpen, setExitDialogOpen] = React.useState(false);

  const requestAppExit = React.useCallback((): void => {
    invoke('request_app_exit').catch((error) => {
      logger.error('Failed to request app exit', error);
    });
  }, []);

  React.useEffect(() => {
    const listeners: Promise<() => void>[] = [];

    const setup = async (): Promise<void> => {
      listeners.push(
        listen('system-open-settings', () => {
          const { setActiveSection, setActiveWorkbenchTab } = useAppStore.getState();
          setActiveSection('workbench');
          setActiveWorkbenchTab('settings');
        }),
      );
      listeners.push(
        listen('system-about', () => {
          setAboutDialogOpen(true);
        }),
      );
      listeners.push(
        listen('system-request-app-exit', () => {
          if (useAppStore.getState().confirmBeforeExit) {
            setExitDialogOpen(true);
          } else {
            requestAppExit();
          }
        }),
      );
      listeners.push(
        listen('system-check-update', () => {
          void useUpdateStore.getState().runCheck('manual');
        }),
      );
    };

    setup();

    return () => {
      Promise.all(listeners).then((unlisteners) => {
        unlisteners.forEach((unlisten) => unlisten());
      });
    };
  }, [requestAppExit]);

  const { ready, t } = useI18n();
  const activeSection = useAppStore((state) => state.activeSection);
  const startupUpdateCheck = useAppStore((state) => state.startupUpdateCheck);
  const connectedSessions = useTerminalStore(
    (state) => state.sessions.filter((session) => session.status === 'connected').length,
  );

  const updatePhase = useUpdateStore((state) => state.phase);
  const updateVersion = useUpdateStore((state) => state.version);
  const updateDownloadProgress = useUpdateStore((state) => state.downloadProgress);
  const restartDialogDismissed = useUpdateStore((state) => state.restartDialogDismissed);
  const installUpdateNow = useUpdateStore((state) => state.installNow);
  const installUpdateLater = useUpdateStore((state) => state.installLater);
  const restartDialogOpen = updatePhase === 'downloaded' && !restartDialogDismissed;

  React.useEffect(() => {
    if (!isTauriRuntime() || !startupUpdateCheck) {
      return;
    }

    const now = Date.now();
    if (!shouldRunStartupUpdateCheck(now)) {
      return;
    }

    const timer = window.setTimeout(() => {
      void useUpdateStore.getState().runCheck('startup');
    }, 8000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [startupUpdateCheck]);

  if (!ready) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-app-bg">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <AppShell>
      <div className="flex min-h-0 flex-1">
        <MainContent>
          <Suspense
            fallback={
              <div className="flex h-full w-full items-center justify-center">
                <Spinner size={24} />
              </div>
            }
          >
            <div
              className={cn(
                'h-full',
                activeSection !== 'workbench' && 'hidden',
              )}
            >
              <Workbench />
            </div>
            <div
              className={cn(
                'h-full',
                activeSection !== 'terminal' && 'hidden',
              )}
            >
              <Terminal />
            </div>
            <div
              className={cn(
                'h-full',
                activeSection !== 'sftp' && 'hidden',
              )}
            >
              <Sftp />
            </div>
          </Suspense>
        </MainContent>
        <AiPanel />
      </div>

      <AboutDialog open={aboutDialogOpen} onClose={() => setAboutDialogOpen(false)} />

      <ConfirmDeleteDialog
        open={exitDialogOpen}
        onOpenChange={setExitDialogOpen}
        title={t('app.exitConfirm.title')}
        description={t('app.exitConfirm.description')}
        confirmLabel={t('app.exitConfirm.confirm')}
        onConfirm={() => {
          setExitDialogOpen(false);
          requestAppExit();
        }}
      />

      <UpdateRestartDialog
        downloadProgress={updateDownloadProgress}
        hasActiveSessions={connectedSessions > 0}
        onInstallNow={installUpdateNow}
        onLater={installUpdateLater}
        open={restartDialogOpen}
        version={
          updateVersion.downloadedVersion ??
          updateVersion.latestVersion ??
          ''
        }
      />

      <CredentialPromptDialog />
      <KeychainKeyPromptDialog />
      <HostKeyDialogHost />

      <Toaster />
    </AppShell>
  );
};
