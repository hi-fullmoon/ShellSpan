import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useToast } from '@/hooks/useToast';
import { useI18n } from '@/hooks/useI18n';
import { invokeRequestAppRestart, isTauriRuntime } from '@/lib/tauri';
import {
  checkForUpdate,
  downloadAndInstallUpdate,
  markStartupUpdateCheck,
  shouldRunStartupUpdateCheck,
  updateFlowReducer,
  type UpdateState,
} from '@/lib/update';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface UseUpdateFlowOptions {
  startupUpdateCheck: boolean;
}

export interface UseUpdateFlowResult {
  updateState: UpdateState;
  updateDownloadProgress: number | undefined;
  restartDialogOpen: boolean;
  runUpdateCheck: (mode: 'startup' | 'manual') => Promise<void>;
  handleInstallUpdateNow: () => void;
  handleInstallUpdateLater: () => void;
}

async function logUpdate(level: 'info' | 'error', message: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }
  try {
    const { info, error } = await import('@tauri-apps/plugin-log');
    if (level === 'info') {
      await info(message);
    } else {
      await error(message);
    }
  } catch {
    // ignore logging failures
  }
}

export function useUpdateFlow({
  startupUpdateCheck,
}: UseUpdateFlowOptions): UseUpdateFlowResult {
  const { t } = useI18n();
  const toast = useToast();
  const [updateState, dispatchUpdateState] = useReducer(updateFlowReducer, {
    phase: 'idle',
    version: {},
  });
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState<number | undefined>(
    undefined,
  );
  const [restartDialogDismissed, setRestartDialogDismissed] = useState(false);

  const runUpdateCheck = useCallback(
    async (mode: 'startup' | 'manual') => {
      if (!isTauriRuntime()) {
        if (mode === 'manual') {
          toast.error(t('update.manualUnavailable'));
        }
        return;
      }

      if (mode === 'manual') {
        if (updateState.phase === 'checking') {
          return;
        }
        if (updateState.phase === 'downloading') {
          toast.info(t('update.downloading'));
          return;
        }
        if (updateState.phase === 'downloaded') {
          setRestartDialogDismissed(false);
          return;
        }
      }

      dispatchUpdateState({ type: 'checkStarted' });
      setUpdateDownloadProgress(undefined);

      try {
        const available = await checkForUpdate();
        if (mode === 'startup') {
          markStartupUpdateCheck(Date.now());
        }

        if (!available) {
          dispatchUpdateState({ type: 'noUpdateFound' });
          if (mode === 'manual') {
            toast.info(t('update.latest'));
          }
          await logUpdate('info', 'No update available');
          return;
        }

        dispatchUpdateState({
          type: 'updateFound',
          payload: { latestVersion: available.version },
        });
        await logUpdate('info', `Update available: ${available.version}`);

        dispatchUpdateState({ type: 'downloadStarted' });
        setUpdateDownloadProgress(0);

        await downloadAndInstallUpdate(available, (percent) => {
          setUpdateDownloadProgress(percent);
        });

        setUpdateDownloadProgress(100);
        dispatchUpdateState({
          type: 'downloadCompleted',
          payload: { downloadedVersion: available.version },
        });
        setRestartDialogDismissed(false);
        await logUpdate('info', `Update downloaded: ${available.version}`);
      } catch (error) {
        const message = t('update.failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        await logUpdate(
          'error',
          `Update check/download failed (${mode}): ${message}`,
        );
        dispatchUpdateState({
          type: 'downloadFailed',
          payload: { message },
        });
        if (mode === 'manual') {
          toast.error(message);
        }
      }
    },
    [t, toast, updateState.phase],
  );

  const runUpdateCheckRef = useRef(runUpdateCheck);
  runUpdateCheckRef.current = runUpdateCheck;

  useEffect(() => {
    if (!isTauriRuntime() || !startupUpdateCheck) {
      return;
    }

    const now = Date.now();
    if (!shouldRunStartupUpdateCheck(now)) {
      return;
    }

    const timer = window.setTimeout(() => {
      void runUpdateCheckRef.current('startup');
    }, 8000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [startupUpdateCheck]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async (): Promise<void> => {
      try {
        const nextUnlisten = await listen('system-check-update', () => {
          void runUpdateCheckRef.current('manual');
        });
        if (cancelled) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
      } catch (error) {
        await logUpdate(
          'error',
          `Failed to listen for system-check-update: ${String(error)}`,
        );
      }
    };

    void attach();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleInstallUpdateNow = useCallback(() => {
    setRestartDialogDismissed(true);
    void (async () => {
      try {
        await logUpdate('info', 'Installing update now');
        await invokeRequestAppRestart();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await logUpdate('error', `Failed to restart for update: ${message}`);
        toast.error(t('update.failed', { error: message }));
      }

      dispatchUpdateState({ type: 'reset' });
    })();
  }, [t, toast]);

  const handleInstallUpdateLater = useCallback(() => {
    setRestartDialogDismissed(true);
    void logUpdate('info', 'Update installation postponed');
  }, []);

  const restartDialogOpen =
    updateState.phase === 'downloaded' && !restartDialogDismissed;

  return {
    updateState,
    updateDownloadProgress,
    restartDialogOpen,
    runUpdateCheck,
    handleInstallUpdateNow,
    handleInstallUpdateLater,
  };
}
