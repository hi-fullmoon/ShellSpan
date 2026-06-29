import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { t } from '../lib/i18n';
import { createLogger } from '../lib/logger';
import { isTauriRuntime } from '../lib/tauri';
import { checkForUpdate, downloadAndInstallUpdate, markStartupUpdateCheck, shouldRunStartupUpdateCheck, updateFlowReducer } from '../lib/update';
import type { UpdateState } from '../types';

const updateLogger = createLogger('app');

export interface UpdateToast {
  message: string;
  tone: 'info' | 'success' | 'error';
}

export interface UseUpdateFlowResult {
  updateState: UpdateState;
  updateDownloadProgress: number | undefined;
  updateToast: UpdateToast | undefined;
  restartDialogDismissed: boolean;
  restartDialogOpen: boolean;
  runUpdateCheck: (mode: 'startup' | 'manual') => Promise<void>;
  handleInstallUpdateNow: () => void;
  handleInstallUpdateLater: () => void;
  setUpdateToast: (toast: UpdateToast | undefined) => void;
  setRestartDialogDismissed: (dismissed: boolean) => void;
}

interface UseUpdateFlowOptions {
  startupUpdateCheck: boolean;
}

export function useUpdateFlow({ startupUpdateCheck }: UseUpdateFlowOptions): UseUpdateFlowResult {
  const [updateState, dispatchUpdateState] = useReducer(updateFlowReducer, { phase: 'idle' });
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState<number>();
  const [updateToast, setUpdateToast] = useState<UpdateToast>();
  const [restartDialogDismissed, setRestartDialogDismissed] = useState(false);

  const runUpdateCheck = useCallback(async (mode: 'startup' | 'manual') => {
    if (!isTauriRuntime()) {
      if (mode === 'manual') {
        setUpdateToast({
          message: t('app.update.manualUnavailable'),
          tone: 'error',
        });
      }
      return;
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
          setUpdateToast({
            message: t('app.update.latest'),
            tone: 'info',
          });
        }
        return;
      }

      dispatchUpdateState({
        type: 'updateFound',
        payload: {
          latestVersion: available.version,
        },
      });
      dispatchUpdateState({ type: 'downloadStarted' });
      setUpdateDownloadProgress(0);

      await downloadAndInstallUpdate(available, (percent) => {
        setUpdateDownloadProgress(percent);
      });

      setUpdateDownloadProgress(100);
      dispatchUpdateState({
        type: 'downloadCompleted',
        payload: {
          downloadedVersion: available.version,
        },
      });
      setRestartDialogDismissed(false);
    } catch (error) {
      const message = t('app.update.failed', { error: String(error) });
      updateLogger.error('检查或下载更新失败', { mode, error: String(error) });
      dispatchUpdateState({
        type: 'downloadFailed',
        payload: {
          message,
        },
      });
      if (mode === 'manual') {
        setUpdateToast({
          message,
          tone: 'error',
        });
      }
    }
  }, []);

  useEffect(() => {
    if (!isTauriRuntime() || !startupUpdateCheck || !shouldRunStartupUpdateCheck(Date.now())) {
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        await runUpdateCheck('startup');
      })();
    }, 8000);

    return () => window.clearTimeout(timer);
  }, [runUpdateCheck, startupUpdateCheck]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let stopSystemCheckUpdate: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      try {
        const nextStopSystemCheckUpdate = await listen('system-check-update', () => {
          void runUpdateCheck('manual');
        });

        if (cancelled) {
          nextStopSystemCheckUpdate();
          return;
        }

        stopSystemCheckUpdate = nextStopSystemCheckUpdate;
      } catch (error) {
        updateLogger.error('监听系统更新检查事件失败', { error: String(error) });
      }
    };

    void attach();

    return () => {
      cancelled = true;
      stopSystemCheckUpdate?.();
    };
  }, [runUpdateCheck]);

  const handleInstallUpdateNow = useCallback(() => {
    updateLogger.info('用户确认立即重启安装更新');
    void (async () => {
      try {
        await invoke('request_app_restart');
        return;
      } catch (error) {
        updateLogger.error('调用原生重启失败，回退到窗口刷新', { error: String(error) });
      }

      setUpdateToast({
        message: t('app.update.restartFallback'),
        tone: 'info',
      });

      window.setTimeout(() => {
        try {
          window.location.reload();
        } catch (error) {
          const message = t('app.update.reloadFailed', { error: String(error) });
          updateLogger.error('回退刷新失败', { error: String(error) });
          setUpdateToast({
            message,
            tone: 'error',
          });
        }
      }, 1000);
    })();
  }, []);

  const handleInstallUpdateLater = useCallback(() => {
    updateLogger.info('用户选择稍后安装更新');
    setRestartDialogDismissed(true);
  }, []);

  const restartDialogOpen = updateState.phase === 'downloaded' && !restartDialogDismissed;

  return {
    updateState,
    updateDownloadProgress,
    updateToast,
    restartDialogDismissed,
    restartDialogOpen,
    runUpdateCheck,
    handleInstallUpdateNow,
    handleInstallUpdateLater,
    setUpdateToast,
    setRestartDialogDismissed,
  };
}
