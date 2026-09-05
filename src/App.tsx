import React, { Suspense } from 'react';
import { cn } from '@/lib/utils';
import { AppShell, MainContent } from '@/components/layout/app-shell';
import { useAppStore } from '@/stores/appStore';
import { useTheme } from '@/hooks/useTheme';
import { useI18n } from '@/hooks/useI18n';
import { useDisableContextMenu } from '@/hooks/useDisableContextMenu';
import { Spinner } from '@/components/ui/empty-state';
import { Toaster } from '@/components/ui/sonner';

const Workbench = React.memo(React.lazy(() => import('@/components/workbench')));
const Terminal = React.memo(React.lazy(() => import('@/components/terminal')));
const Sftp = React.memo(React.lazy(() => import('@/components/sftp')));
const SettingsPanel = React.lazy(() => import('@/components/workbench/settings-panel').then((module) => ({
  default: module.SettingsPanel,
})));

import { useTransferListeners } from '@/hooks/useTransferListeners';
import { useMonitorEvents } from '@/hooks/useMonitorEvents';
import { useTerminalStore } from '@/stores/terminalStore';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { AboutDialog } from '@/components/about-dialog';
import { UpdateRestartDialog } from '@/components/update-restart-dialog';
import { useUpdateStore } from '@/stores/updateStore';
import { isTauriRuntime } from '@/lib/ipc/tauri';
import { shouldRunStartupUpdateCheck } from '@/lib/update';
import { createLogger } from '@/lib/logger';
import { useAppShortcuts } from '@/hooks/useAppShortcuts';
import { CredentialPromptDialog } from '@/components/terminal/credential-prompt-dialog';
import { KeychainKeyPromptDialog } from '@/components/terminal/keychain-key-prompt-dialog';
import { HostKeyDialogHost } from '@/components/terminal/host-key-dialog-host';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { AiPanel } from '@/components/ai/ai-panel';
import { flushTerminalWorkspace } from '@/lib/terminal/terminal-workspace-persistence';
import { flushSftpWorkspace } from '@/lib/sftp/sftp-workspace-persistence';
import { flushAiSettingsPreferences } from '@/stores/aiSettingsStore';
import { CommandPalette } from '@/components/command-palette';
import { isTransferActive, useTransferStore } from '@/stores/transferStore';
import {
  isPortForwardActive,
  usePortForwardStore,
} from '@/stores/portForwardStore';
import { usePortForwardEvents } from '@/hooks/usePortForwardEvents';
const logger = createLogger('app');

interface AppSectionsProps {
  onCheckForUpdates: () => void;
  onOpenAbout: () => void;
  onRequestExit: () => void;
}

const AppSections: React.FC<AppSectionsProps> = ({
  onCheckForUpdates,
  onOpenAbout,
  onRequestExit,
}) => {
  const activeSection = useAppStore((state) => state.activeSection);

  return (
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
        <Workbench
          onCheckForUpdates={onCheckForUpdates}
          onOpenAbout={onOpenAbout}
          onRequestExit={onRequestExit}
        />
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
  );
};

export const App: React.FC = () => {
  useDisableContextMenu();
  useTheme();
  useTransferListeners();
  usePortForwardEvents();
  useMonitorEvents();
  useAppShortcuts();

  const [aboutDialogOpen, setAboutDialogOpen] = React.useState(false);
  const [exitDialogOpen, setExitDialogOpen] = React.useState(false);
  const settingsDialogOpen = useAppStore((state) => state.settingsDialogOpen);
  const setSettingsDialogOpen = useAppStore((state) => state.setSettingsDialogOpen);
  const exitInFlightRef = React.useRef(false);

  const checkForUpdates = React.useCallback((): void => {
    void useUpdateStore.getState().runCheck('manual');
  }, []);

  const openAbout = React.useCallback((): void => {
    setAboutDialogOpen(true);
  }, []);

  const requestAppExit = React.useCallback((): void => {
    if (exitInFlightRef.current) return;
    exitInFlightRef.current = true;
    void Promise.all([
      flushAiSettingsPreferences().catch((error) => {
        logger.warn('Failed to flush AI settings before exit', error);
      }),
      flushTerminalWorkspace().catch((error) => {
        logger.warn('Failed to flush terminal workspace before exit', error);
      }),
      flushSftpWorkspace().catch((error) => {
        logger.warn('Failed to flush SFTP workspace before exit', error);
      }),
      usePortForwardStore.getState().stopAll().catch((error) => {
        logger.warn('Failed to stop port forwards before exit', error);
      }),
    ])
      .then(() => invoke('request_app_exit'))
      .catch((error) => {
        exitInFlightRef.current = false;
        logger.error('Failed to request app exit', error);
      });
  }, []);

  const requestUserExit = React.useCallback((): void => {
    if (useAppStore.getState().confirmBeforeExit) {
      setExitDialogOpen(true);
    } else {
      requestAppExit();
    }
  }, [requestAppExit]);

  React.useEffect(() => {
    const listeners: Promise<() => void>[] = [];

    const setup = async (): Promise<void> => {
      listeners.push(
        listen('system-open-settings', () => {
          useAppStore.getState().openSettings();
        }),
      );
      listeners.push(
        listen('system-about', () => {
          setAboutDialogOpen(true);
        }),
      );
      listeners.push(
        listen('system-request-app-exit', () => {
          requestUserExit();
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
  }, [requestUserExit]);

  const { ready, t } = useI18n();
  const startupUpdateCheck = useAppStore((state) => state.startupUpdateCheck);
  const connectedSessions = useTerminalStore(
    (state) => state.sessions.filter((session) => session.status === 'connected').length,
  );
  const activeTransfers = useTransferStore(
    (state) => state.operations.filter(isTransferActive).length,
  );
  const activePortForwards = usePortForwardStore(
    (state) => state.runtimes.filter(isPortForwardActive).length,
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
      <div className="relative flex min-h-0 flex-1">
        <MainContent>
          <AppSections
            onCheckForUpdates={checkForUpdates}
            onOpenAbout={openAbout}
            onRequestExit={requestUserExit}
          />
        </MainContent>
        <AiPanel />
      </div>

      <AboutDialog open={aboutDialogOpen} onClose={() => setAboutDialogOpen(false)} />

      {settingsDialogOpen && (
        <Suspense fallback={null}>
          <SettingsPanel open onOpenChange={setSettingsDialogOpen} />
        </Suspense>
      )}

      <ConfirmationDialog
        open={exitDialogOpen}
        onOpenChange={setExitDialogOpen}
        title={t('app.exitConfirm.title')}
        description={activeTransfers > 0 || activePortForwards > 0
          ? t('app.exitConfirm.activeOperations', {
              transfers: activeTransfers,
              forwards: activePortForwards,
            })
          : t('app.exitConfirm.description')}
        confirmLabel={t('app.exitConfirm.confirm')}
        confirmVariant="destructive"
        onConfirm={() => {
          setExitDialogOpen(false);
          requestAppExit();
        }}
      />

      <UpdateRestartDialog
        downloadProgress={updateDownloadProgress}
        hasActiveSessions={connectedSessions > 0}
        activeTransferCount={activeTransfers}
        activePortForwardCount={activePortForwards}
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
      <CommandPalette />

      <Toaster />
    </AppShell>
  );
};
