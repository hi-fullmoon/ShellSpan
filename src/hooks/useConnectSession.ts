import { useEffect, useRef, useState } from 'react';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import type { ConnectionProfile, SessionErrorEvent } from '@/types';
import {
  buildSessionCreateRequest,
  invokeCreateLocalSession,
  invokeCreateSession,
  invokeTrustHost,
  listenToSessionError,
} from '@/lib/tauri';
import { useToastStore } from '@/stores/toastStore';
import { createLogger } from '@/lib/logger';
import { promptForMissingPassword } from '@/lib/password-prompt';
import { getErrorMessage, getLocalizedErrorMessage } from '@/lib/error';
import {
  ensureKeychainKeyForProfile,
  ensurePasswordKeychain,
  prepareKeychainKeyForProfile,
  promptForMissingKeychainKey,
} from '@/lib/keychain-key-prompt';
import { useReconnectSession } from './useReconnectSession';

interface HostKeyDialogState {
  open: boolean;
  host: string;
  port: number;
  fingerprint?: string;
  mismatch: boolean;
  onTrust: () => void;
}

const CLOSED_DIALOG: HostKeyDialogState = {
  open: false,
  host: '',
  port: 22,
  mismatch: false,
  onTrust: () => {},
};

// Module-level guard so multiple hook instances (Workbench + Terminal) do not
// open duplicate dialogs for the same failing session.
const processingSessionErrors = new Set<string>();

const logger = createLogger('connect');

export function useConnectSession(): {
  connect: (
    profile: ConnectionProfile,
    options?: { insertAfterId?: string; pinned?: boolean; color?: string },
  ) => Promise<void>;
  openLocal: () => Promise<void>;
  hostKeyDialog: HostKeyDialogState;
  closeHostKeyDialog: () => void;
} {
  const addSession = useTerminalStore((state) => state.addSession);
  const setActiveSection = useAppStore((state) => state.setActiveSection);
  const reconnect = useReconnectSession();

  const [hostKeyDialog, setHostKeyDialog] = useState<HostKeyDialogState>(CLOSED_DIALOG);
  const pendingProfileRef = useRef<ConnectionProfile | null>(null);
  const currentErrorSessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listenToSessionError((event) => {
      const errorEvent = event.payload as SessionErrorEvent;
      handleSessionError(errorEvent);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((error) => {
        logger.error('Failed to listen for session errors', error);
      });

    return () => {
      unlisten?.();
    };
  }, [reconnect]);

  const connect = async (
    profile: ConnectionProfile,
    options?: { insertAfterId?: string; pinned?: boolean; color?: string },
  ): Promise<void> => {
    logger.info(`Connecting to ${profile.host}:${profile.port} as ${profile.username}`);

    let currentProfile = profile;
    let keyPromptShown = false;

    while (true) {
      const profileWithPassword = await promptForMissingPassword(currentProfile);
      if (!profileWithPassword) {
        logger.info('Connection cancelled by user (password dialog dismissed)');
        return;
      }

      const ensuredProfile = await ensureKeychainKeyForProfile(profileWithPassword);
      if (!ensuredProfile) {
        logger.info('Connection cancelled by user (key prompt dismissed)');
        return;
      }

      const passwordStoredProfile = await ensurePasswordKeychain(ensuredProfile);
      if (!passwordStoredProfile) {
        logger.info('Connection cancelled (password keychain unavailable)');
        return;
      }

      const preparedProfile = await prepareKeychainKeyForProfile(passwordStoredProfile);
      if (!preparedProfile) {
        logger.info('Connection cancelled by user (keychain password prompt dismissed)');
        return;
      }

      pendingProfileRef.current = preparedProfile;

      try {
        const summary = await invokeCreateSession(
          buildSessionCreateRequest(preparedProfile, 120, 30),
        );
        addSession(summary, profile.id, options);
        logger.info(`Connected to ${profile.host}:${profile.port} (session ${summary.sessionId})`);
        useRecentProfilesStore.getState().touchProfile(profile.id);
        setActiveSection('terminal');
        return;
      } catch (error) {
        const message = getErrorMessage(error);
        if (
          !keyPromptShown &&
          preparedProfile.authMethod === 'key' &&
          message.toLowerCase().startsWith('keychain key not found:')
        ) {
          const recovered = await promptForMissingKeychainKey(preparedProfile);
          if (!recovered) {
            logger.info('Connection cancelled by user (key prompt dismissed)');
            return;
          }
          keyPromptShown = true;
          currentProfile = recovered;
          continue;
        }

        handleConnectionError(error, () => {
          const pending = pendingProfileRef.current;
          if (pending) {
            void connect(pending, options);
          }
        });
        return;
      }
    }
  };

  const openLocal = async (): Promise<void> => {
    try {
      const summary = await invokeCreateLocalSession();
      addSession(summary);
      setActiveSection('terminal');
    } catch (error) {
      useToastStore.getState().addToast(getLocalizedErrorMessage(error), 'error');
    }
  };

  const handleSessionError = (errorEvent: SessionErrorEvent): void => {
    if (errorEvent.type !== 'HostKeyUnknown' && errorEvent.type !== 'HostKeyMismatch') {
      return;
    }

    const { sessionId, host, port } = errorEvent.payload;

    // Guard against multiple hook instances or duplicate events opening multiple dialogs.
    if (processingSessionErrors.has(sessionId) || hostKeyDialog.open) {
      return;
    }
    processingSessionErrors.add(sessionId);
    currentErrorSessionIdRef.current = sessionId;

    const fingerprint = errorEvent.type === 'HostKeyUnknown' ? errorEvent.payload.fingerprint : undefined;

    logger.warn(
      `Host key verification prompt (${errorEvent.type}) for session ${sessionId} ${host}:${port}`,
    );

    setHostKeyDialog({
      open: true,
      host,
      port,
      fingerprint,
      mismatch: errorEvent.type === 'HostKeyMismatch',
      onTrust: () => {
        invokeTrustHost(host, port)
          .then(() => {
            setHostKeyDialog(CLOSED_DIALOG);
            processingSessionErrors.delete(sessionId);
            void reconnect(sessionId);
          })
          .catch((error: unknown) => {
            processingSessionErrors.delete(sessionId);
            useToastStore.getState().addToast(getLocalizedErrorMessage(error), 'error');
          });
      },
    });
  };

  const handleConnectionError = (
    error: unknown,
    retry: () => void,
  ): void => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'type' in error
    ) {
      const typed = error as { type: string; payload?: Record<string, unknown> };
      if (typed.type === 'HostKeyUnknown') {
        const payload = typed.payload ?? {};
        const host = String(payload.host ?? '');
        const port = Number(payload.port ?? 22);
        logger.warn(`Host key verification prompt (${typed.type}) for ${host}:${port}`);
        setHostKeyDialog({
          open: true,
          host,
          port,
          fingerprint: payload.fingerprint
            ? String(payload.fingerprint)
            : undefined,
          mismatch: false,
          onTrust: () => {
            invokeTrustHost(host, port).then(() => {
              setHostKeyDialog(CLOSED_DIALOG);
              retry();
            });
          },
        });
        return;
      }
      if (typed.type === 'HostKeyMismatch') {
        const payload = typed.payload ?? {};
        const host = String(payload.host ?? '');
        const port = Number(payload.port ?? 22);
        logger.warn(`Host key verification prompt (${typed.type}) for ${host}:${port}`);
        setHostKeyDialog({
          open: true,
          host,
          port,
          mismatch: true,
          onTrust: () => {
            invokeTrustHost(host, port).then(() => {
              setHostKeyDialog(CLOSED_DIALOG);
              retry();
            });
          },
        });
        return;
      }
    }
    useToastStore.getState().addToast(getLocalizedErrorMessage(error), 'error');
    logger.error('Connection failed', error);
  };

  const closeHostKeyDialog = (): void => {
    if (currentErrorSessionIdRef.current) {
      processingSessionErrors.delete(currentErrorSessionIdRef.current);
      currentErrorSessionIdRef.current = null;
    }
    setHostKeyDialog(CLOSED_DIALOG);
  };

  return {
    connect,
    openLocal,
    hostKeyDialog,
    closeHostKeyDialog,
  };
}
