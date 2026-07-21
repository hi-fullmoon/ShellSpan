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
import { createLogger } from '@/lib/logger';
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

const logger = createLogger('update');

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
  const checkingRef = useRef(false);

  const runUpdateCheck = useCallback(
    async (mode: 'startup' | 'manual') => {
      if (!isTauriRuntime()) {
        if (mode === 'manual') {
          toast.error(t('update.manualUnavailable'));
        }
        return;
      }

      if (mode === 'manual') {
        if (updateState.phase === 'downloading') {
          toast.info(t('update.downloading'));
          return;
        }
        if (updateState.phase === 'downloaded') {
          setRestartDialogDismissed(false);
          return;
        }
      }

      // Synchronous guard: prevents concurrent calls before React state updates.
      // Keep this after the phase checks so manual checks still provide feedback.
      if (checkingRef.current) {
        return;
      }

      checkingRef.current = true;
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
          logger.info('No update available');
          return;
        }

        dispatchUpdateState({
          type: 'updateFound',
          payload: { latestVersion: available.version },
        });
        logger.info(`Update available: ${available.version}`);

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
        logger.info(`Update downloaded: ${available.version}`);
      } catch (error) {
        const message = t('update.failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        logger.error(`Update check/download failed (${mode}): ${message}`);
        dispatchUpdateState({
          type: 'downloadFailed',
          payload: { message },
        });
        if (mode === 'manual') {
          toast.error(message);
        }
      } finally {
        checkingRef.current = false;
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
        logger.error(`Failed to listen for system-check-update: ${String(error)}`);
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
        logger.info('Installing update now');
        await invokeRequestAppRestart();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to restart for update: ${message}`);
        toast.error(t('update.failed', { error: message }));
      }

      dispatchUpdateState({ type: 'reset' });
    })();
  }, [t, toast]);

  const handleInstallUpdateLater = useCallback(() => {
    setRestartDialogDismissed(true);
    logger.info('Update installation postponed');
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
