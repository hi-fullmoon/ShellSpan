import { useCallback } from 'react';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import type { ConnectionProfile } from '@/types';
import {
  buildSessionCreateRequest,
  invokeCreateLocalSession,
  invokeCreateSession,
} from '@/lib/ipc/tauri';
import { useToastStore } from '@/stores/toastStore';
import { createLogger } from '@/lib/logger';
import { promptForMissingPassword, persistPromptedPassword } from '@/lib/connections/password-prompt';
import { getErrorMessage, getToastErrorMessage } from '@/lib/error';
import {
  ensureKeychainKeyForProfile,
  getMissingKeychainKeyTarget,
  promptForMissingKeychainKey,
} from '@/lib/connections/keychain-key-prompt';
import { openHostKeyPrompt } from '@/lib/host/host-key-prompt';
import { useProfileStore } from '@/stores/profileStore';
import { usePortForwardStore } from '@/stores/portForwardStore';
import { t } from '@/locales';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';

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
    const originalSection = useAppStore.getState().activeSection;
    const originalSessionId = useTerminalStore.getState().activeSessionId;
    let connectionAttemptId = options?.connectionAttemptId;
    let cancelled = false;
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
          cancelled = true;
          logger.info('Connection cancelled by user (password dialog dismissed)');
          return;
        }

        const ensuredProfile = await ensureKeychainKeyForProfile(profileWithPassword);
        if (!ensuredProfile) {
          cancelled = true;
          logger.info('Connection cancelled by user (key prompt dismissed)');
          return;
        }

        const preparedProfile = ensuredProfile;
        connectionAttemptId = beginConnectionAttempt({
          title: profile.name || profile.host,
          host: profile.host,
          port: profile.port,
          username: profile.username,
          profileId: profile.id,
          insertAfterId: options?.insertAfterId,
          pinned: options?.pinned,
          color: options?.color,
        }, connectionAttemptId);
        setActiveSection('terminal');

        try {
          const summary = await invokeCreateSession(
            {
              ...buildSessionCreateRequest(preparedProfile, 120, 30),
              initialDirectory: options?.initialDirectory,
            },
          );
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
              cancelled = true;
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
          const errorType = typeof error === 'object' && error !== null && 'type' in error
            ? error.type : undefined;
          if (errorType !== 'HostKeyUnknown' && errorType !== 'HostKeyMismatch') {
            useTerminalStore.getState().setStatus(connectionAttemptId, {
              sessionId: connectionAttemptId,
              status: 'error',
              message: getToastErrorMessage(error),
            });
          }
          return;
        }
      }
    } finally {
      if (connectionAttemptId) {
        const terminal = useTerminalStore.getState();
        // Only restore navigation while this attempt still owns the selection.
        // A different tab or connection selected during the prompt takes priority.
        if (cancelled && terminal.activeSessionId === connectionAttemptId) {
          if (originalSessionId === null || terminal.sessions.some(
            (session) => session.sessionId === originalSessionId,
          )) {
            terminal.setActiveSession(originalSessionId);
          }
          if (useAppStore.getState().activeSection === 'terminal') {
            setActiveSection(originalSection);
          }
        }
        endConnectionAttempt(connectionAttemptId);
      }
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
      const dimensions = await terminalRegistry.measureInitialDimensions(connectionAttemptId);
      if (!useTerminalStore.getState().sessions.some((session) => session.sessionId === connectionAttemptId)) return;
      const summary = await invokeCreateLocalSession(dimensions?.cols, dimensions?.rows);
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
