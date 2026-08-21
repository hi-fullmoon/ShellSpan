import { useCallback } from 'react';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import type { ConnectionProfile } from '@/types';
import {
  buildSessionCreateRequest,
  invokeCreateLocalSession,
  invokeCreateSession,
} from '@/lib/tauri';
import { useToastStore } from '@/stores/toastStore';
import { createLogger } from '@/lib/logger';
import { promptForMissingPassword, persistPromptedPassword } from '@/lib/password-prompt';
import { getErrorMessage, getToastErrorMessage } from '@/lib/error';
import {
  ensureKeychainKeyForProfile,
  getMissingKeychainKeyTarget,
  promptForMissingKeychainKey,
} from '@/lib/keychain-key-prompt';
import { openHostKeyPrompt } from '@/lib/host-key-prompt';
import { useProfileStore } from '@/stores/profileStore';

const logger = createLogger('connect');

export function useConnectSession(): {
  connect: (
    profile: ConnectionProfile,
    options?: { insertAfterId?: string; pinned?: boolean; color?: string },
  ) => Promise<void>;
  openLocal: () => Promise<void>;
} {
  const addSession = useTerminalStore((state) => state.addSession);
  const setActiveSection = useAppStore((state) => state.setActiveSection);

  const handleConnectionError = useCallback((
    error: unknown,
    retry: () => void,
  ): void => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'type' in error
    ) {
      const typed = error as { type: string; payload?: Record<string, unknown> };
      if (typed.type === 'HostKeyUnknown' || typed.type === 'HostKeyMismatch') {
        const payload = typed.payload ?? {};
        const host = String(payload.host ?? '');
        const port = Number(payload.port ?? 22);
        logger.warn(`Host key verification prompt (${typed.type}) for ${host}:${port}`);
        openHostKeyPrompt({
          host,
          port,
          fingerprint:
            typed.type === 'HostKeyUnknown' && payload.fingerprint
              ? String(payload.fingerprint)
              : undefined,
          mismatch: typed.type === 'HostKeyMismatch',
          onTrusted: retry,
        });
        return;
      }
    }
    useToastStore.getState().addToast(getToastErrorMessage(error), 'error');
    logger.error('Connection failed', error);
  }, []);

  const connect: (
    profile: ConnectionProfile,
    options?: { insertAfterId?: string; pinned?: boolean; color?: string },
  ) => Promise<void> = useCallback(async (
    profile: ConnectionProfile,
    options?: { insertAfterId?: string; pinned?: boolean; color?: string },
  ): Promise<void> => {
    logger.info(`Connecting to ${profile.host}:${profile.port} as ${profile.username}`);

    let currentProfile = profile;
    let keyPromptShown = false;

    while (true) {
      const profileWithSavedSecrets = await useProfileStore
        .getState()
        .ensurePassword(currentProfile);
      const profileWithPassword = await promptForMissingPassword(profileWithSavedSecrets);
      if (!profileWithPassword) {
        logger.info('Connection cancelled by user (password dialog dismissed)');
        return;
      }

      const ensuredProfile = await ensureKeychainKeyForProfile(profileWithPassword);
      if (!ensuredProfile) {
        logger.info('Connection cancelled by user (key prompt dismissed)');
        return;
      }

      const preparedProfile = ensuredProfile;

      try {
        const summary = await invokeCreateSession(
          buildSessionCreateRequest(preparedProfile, 120, 30),
        );
        await persistPromptedPassword(profileWithSavedSecrets, preparedProfile);
        addSession(summary, profile.id, options);
        logger.info(`Connected to ${profile.host}:${profile.port} (session ${summary.sessionId})`);
        useRecentProfilesStore.getState().touchProfile(profile.id);
        setActiveSection('terminal');
        return;
      } catch (error) {
        const message = getErrorMessage(error);
        const missingKeyTarget = getMissingKeychainKeyTarget(preparedProfile, message);
        if (
          !keyPromptShown &&
          missingKeyTarget
        ) {
          const recovered = await promptForMissingKeychainKey(
            preparedProfile,
            missingKeyTarget,
          );
          if (!recovered) {
            logger.info('Connection cancelled by user (key prompt dismissed)');
            return;
          }
          keyPromptShown = true;
          currentProfile = recovered;
          continue;
        }

        handleConnectionError(error, () => {
          void connect(preparedProfile, options);
        });
        return;
      }
    }
  }, [addSession, handleConnectionError, setActiveSection]);

  const openLocal = async (): Promise<void> => {
    try {
      const summary = await invokeCreateLocalSession();
      addSession(summary);
      setActiveSection('terminal');
    } catch (error) {
      useToastStore.getState().addToast(getToastErrorMessage(error), 'error');
    }
  };

  return {
    connect,
    openLocal,
  };
}
