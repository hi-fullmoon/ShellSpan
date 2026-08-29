import { create } from 'zustand';
import { createLogger } from '@/lib/logger';
import {
  checkForUpdate,
  downloadAndInstallUpdate,
  markStartupUpdateCheck,
  updateFlowReducer,
} from '@/lib/update';
import { invokeRequestAppRestart, isTauriRuntime } from '@/lib/tauri';
import { useToastStore } from '@/stores/toastStore';
import { t } from '@/locales';
import type { UpdateStatus, UpdateVersionInfo } from '@/types';
import { usePortForwardStore } from '@/stores/portForwardStore';
import { finalizeAiSessionsBeforeExit } from '@/lib/ai-sessions';

const logger = createLogger('update');

// Synchronous guard against concurrent check/download runs. Deliberately kept
// out of the reactive state: it must be set and cleared within the same tick,
// before React would flush any state update.
let checkingRef = false;

export interface UpdateStore {
  phase: UpdateStatus;
  version: UpdateVersionInfo;
  error?: string;
  /** 0-100 when the download total is known; undefined before a download. */
  downloadProgress?: number;
  /** True while a download is in flight whose total size is unknown. */
  downloadIndeterminate: boolean;
  restartDialogDismissed: boolean;
  runCheck: (mode: 'startup' | 'manual') => Promise<void>;
  installNow: () => Promise<void>;
  installLater: () => void;
  reset: () => void;
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  phase: 'idle',
  version: {},
  downloadIndeterminate: false,
  restartDialogDismissed: false,

  runCheck: async (mode) => {
    if (!isTauriRuntime()) {
      if (mode === 'manual') {
        useToastStore.getState().addToast(t('update.manualUnavailable'), 'error');
      }
      return;
    }

    const { phase } = get();
    if (mode === 'manual') {
      if (phase === 'downloading') {
        useToastStore.getState().addToast(t('update.downloading'), 'info');
        return;
      }
      if (phase === 'downloaded') {
        set({ restartDialogDismissed: false });
        return;
      }
    }

    // Synchronous guard: prevents concurrent calls before React state updates.
    // Keep this after the phase checks so manual checks still provide feedback.
    if (checkingRef) {
      return;
    }
    checkingRef = true;

    set({
      ...updateFlowReducer(get(), { type: 'checkStarted' }),
      error: undefined,
      downloadProgress: undefined,
      downloadIndeterminate: false,
    });

    try {
      const available = await checkForUpdate();
      if (mode === 'startup') {
        markStartupUpdateCheck(Date.now());
      }

      if (!available) {
        set(updateFlowReducer(get(), { type: 'noUpdateFound' }));
        if (mode === 'manual') {
          useToastStore.getState().addToast(t('update.latest'), 'info');
        }
        logger.info('No update available');
        return;
      }

      set(
        updateFlowReducer(get(), {
          type: 'updateFound',
          payload: { latestVersion: available.version },
        }),
      );
      logger.info(`Update available: ${available.version}`);
      if (mode === 'manual') {
        useToastStore
          .getState()
          .addToast(t('update.available', { version: available.version }), 'info');
      }

      set(updateFlowReducer(get(), { type: 'downloadStarted' }));
      set({ downloadProgress: 0 });

      await downloadAndInstallUpdate(available, (progress) => {
        if (progress.percent === undefined) {
          set({ downloadIndeterminate: true });
        } else {
          set({ downloadProgress: progress.percent, downloadIndeterminate: false });
        }
      });

      set({ downloadProgress: 100, downloadIndeterminate: false });
      set(
        updateFlowReducer(get(), {
          type: 'downloadCompleted',
          payload: { downloadedVersion: available.version },
        }),
      );
      set({ restartDialogDismissed: false });
      logger.info(`Update downloaded: ${available.version}`);
    } catch (error) {
      const message = t('update.failedFriendly');
      logger.error(`Update check/download failed (${mode})`, error);
      set(updateFlowReducer(get(), { type: 'downloadFailed', payload: { message } }));
      if (mode === 'manual') {
        useToastStore.getState().addToast(message, 'error');
      }
    } finally {
      checkingRef = false;
    }
  },

  installNow: async () => {
    set({ restartDialogDismissed: true });
    try {
      logger.info('Installing update now');
      await finalizeAiSessionsBeforeExit();
      await usePortForwardStore.getState().stopAll();
      await invokeRequestAppRestart();
      return;
    } catch (error) {
      logger.error('Failed to restart for update', error);
      useToastStore.getState().addToast(t('update.failedFriendly'), 'error');
    }
    set({
      ...updateFlowReducer(get(), { type: 'reset' }),
      error: undefined,
      downloadProgress: undefined,
      downloadIndeterminate: false,
    });
  },

  installLater: () => {
    set({ restartDialogDismissed: true });
    logger.info('Update installation postponed');
  },

  reset: () => {
    checkingRef = false;
    set({
      ...updateFlowReducer(get(), { type: 'reset' }),
      error: undefined,
      downloadProgress: undefined,
      downloadIndeterminate: false,
      restartDialogDismissed: false,
    });
  },
}));
