import { useCallback } from 'react';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import type { ConnectionProfile } from '@/types';
import {
  buildSessionCreateRequest,
  invokeCreateLocalSession,
  invokeCreateSession,
  invokeWriteSession,
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
import { buildChangeDirectoryCommand } from '@/lib/host-context';
import { usePortForwardStore } from '@/stores/portForwardStore';
import { t } from '@/locales';

export interface ConnectSessionOptions {
  insertAfterId?: string;
  pinned?: boolean;
  color?: string;
  initialDirectory?: string;
  connectionAttemptId?: string;
}

const logger = createLogger('connect');

export function useConnectSession(): {
  connect: (
    profile: ConnectionProfile,
    options?: ConnectSessionOptions,
  ) => Promise<void>;
  openLocal: () => Promise<void>;
} {
  const beginConnectionAttempt = useTerminalStore((state) => state.beginConnectionAttempt);
  const resolveConnectionAttempt = useTerminalStore((state) => state.resolveConnectionAttempt);
  const endConnectionAttempt = useTerminalStore((state) => state.endConnectionAttempt);
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
          fingerprint: payload.fingerprint ? String(payload.fingerprint) : undefined,
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
    options?: ConnectSessionOptions,
  ) => Promise<void> = useCallback(async (
    profile: ConnectionProfile,
    options?: ConnectSessionOptions,
  ): Promise<void> => {
    const connectionAttemptId = beginConnectionAttempt({
      title: profile.name || profile.host,
      host: profile.host,
      port: profile.port,
      username: profile.username,
      profileId: profile.id,
      insertAfterId: options?.insertAfterId,
      pinned: options?.pinned,
      color: options?.color,
    }, options?.connectionAttemptId);
    setActiveSection('terminal');
    logger.info(`Connecting to ${profile.host}:${profile.port} as ${profile.username}`);

    try {
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
          if (options?.initialDirectory) {
            const changeDirectoryCommand = buildChangeDirectoryCommand(options.initialDirectory);
            if (changeDirectoryCommand) {
              try {
                await invokeWriteSession(summary.sessionId, changeDirectoryCommand);
              } catch (error) {
                logger.error(
                  `failed to set initial directory session_id=${summary.sessionId}`,
                  error,
                );
                useToastStore.getState().addToast(getToastErrorMessage(error), 'error');
              }
            }
          }
          // Do not expose the connected session to Agent execution until the
          // initial-directory write (which includes Enter) is complete. This
          // prevents it from interleaving with a paced terminal wrapper.
          resolveConnectionAttempt(connectionAttemptId, summary, profile.id);
          await persistPromptedPassword(profileWithSavedSecrets, preparedProfile);
          void usePortForwardStore
            .getState()
            .startAutoForOwner(preparedProfile, `terminal:${summary.sessionId}`);
          logger.info(`Connected to ${profile.host}:${profile.port} (session ${summary.sessionId})`);
          useRecentProfilesStore.getState().touchProfile(profile.id);
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
    } finally {
      endConnectionAttempt(connectionAttemptId);
    }
  }, [beginConnectionAttempt, endConnectionAttempt, handleConnectionError, resolveConnectionAttempt, setActiveSection]);

  const openLocal = async (): Promise<void> => {
    const connectionAttemptId = beginConnectionAttempt({
      title: t('terminal.newSession.localTerminal'),
      host: '',
      port: 0,
      username: '',
    });
    setActiveSection('terminal');
    try {
      const summary = await invokeCreateLocalSession();
      resolveConnectionAttempt(connectionAttemptId, summary);
    } catch (error) {
      useToastStore.getState().addToast(getToastErrorMessage(error), 'error');
    } finally {
      endConnectionAttempt(connectionAttemptId);
    }
  };

  return {
    connect,
    openLocal,
  };
}
