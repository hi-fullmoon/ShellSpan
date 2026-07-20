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
import { useTerminalStore } from '@/stores/terminalStore';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { AboutDialog } from '@/components/about-dialog';
import { UpdateRestartDialog } from '@/components/update-restart-dialog';
import { useUpdateFlow } from '@/hooks/useUpdateFlow';
import { createLogger } from '@/lib/logger';
import { useAppShortcuts } from '@/hooks/useAppShortcuts';
import { CredentialPromptDialog } from '@/components/terminal/credential-prompt-dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const logger = createLogger('app');

export const App: React.FC = () => {
  useDisableContextMenu();
  useTheme();
  useTransferListeners();
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

  const {
    updateState,
    updateDownloadProgress,
    restartDialogOpen,
    handleInstallUpdateNow,
    handleInstallUpdateLater,
  } = useUpdateFlow({ startupUpdateCheck });

  if (!ready) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-app-bg">
        <Spinner size={24} />
      </div>
    );
  }

  return (
    <AppShell>
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

      <AboutDialog open={aboutDialogOpen} onClose={() => setAboutDialogOpen(false)} />

      <AlertDialog open={exitDialogOpen} onOpenChange={setExitDialogOpen}>
        <AlertDialogContent className="min-w-0 max-w-sm gap-0 overflow-hidden border-app-border bg-app-surface p-0">
          <AlertDialogHeader className="place-items-start px-4 py-2.5 text-left">
            <AlertDialogTitle className="text-sm leading-5">
              {t('app.exitConfirm.title')}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <div className="min-w-0 max-w-full overflow-hidden px-4 py-3">
            <AlertDialogDescription className="block min-w-0 max-w-full break-all text-left leading-5 text-app-text">
              {t('app.exitConfirm.description')}
            </AlertDialogDescription>
          </div>
          <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-app-surface px-4 py-2.5">
            <AlertDialogCancel size="sm">
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="sm"
              onClick={() => {
                setExitDialogOpen(false);
                requestAppExit();
              }}
            >
              {t('app.exitConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <UpdateRestartDialog
        downloadProgress={updateDownloadProgress}
        hasActiveSessions={connectedSessions > 0}
        onInstallNow={handleInstallUpdateNow}
        onLater={handleInstallUpdateLater}
        open={restartDialogOpen}
        version={
          updateState.version.downloadedVersion ??
          updateState.version.latestVersion ??
          ''
        }
      />

      <CredentialPromptDialog />

      <Toaster />
    </AppShell>
  );
};
