import { useCallback, useState } from 'react';
import {
  buildRemoteConnectionRequest,
  invokeCheckHostKey,
  invokeTrustHost,
  invokeWarmRemoteConnection,
  parseRemoteFsError,
} from '@/lib/tauri';
import { generateId } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { useSftpStore, type SftpSide } from '@/stores/sftpStore';
import { useToastStore } from '@/stores/toastStore';
import type { ConnectionProfile, RemoteFsError } from '@/types';
import { promptForMissingPassword, persistPromptedPassword } from '@/lib/password-prompt';
import { getToastErrorMessage } from '@/lib/error';
import { createLogger } from '@/lib/logger';
import {
  ensureKeychainKeyForProfile,
} from '@/lib/keychain-key-prompt';
import { useProfileStore } from '@/stores/profileStore';
import { usePortForwardStore } from '@/stores/portForwardStore';

const logger = createLogger('sftp');

interface SftpHostKeyDialogState {
  open: boolean;
  host: string;
  port: number;
  fingerprint?: string;
  mismatch: boolean;
  onTrust: () => void;
}

const CLOSED_DIALOG: SftpHostKeyDialogState = {
  open: false,
  host: '',
  port: 22,
  mismatch: false,
  onTrust: () => {},
};

export function useSftpConnectionOpener(): {
  open: (
    profile: ConnectionProfile,
    targetConnectionId?: string,
    targetSide?: SftpSide,
    initialDirectory?: string,
  ) => Promise<void>;
  verifyHostKey: (host: string, port: number, onVerified: () => void) => Promise<void>;
  hostKeyDialog: SftpHostKeyDialogState;
  closeHostKeyDialog: () => void;
} {
  const addConnection = useSftpStore((state) => state.addConnection);
  const attachRemoteConnection = useSftpStore((state) => state.attachRemoteConnection);
  const hydrateSftpBookmarks = useSftpStore((state) => state.hydrateSftpBookmarks);
  const setActiveSection = useAppStore((state) => state.setActiveSection);
  const touchProfile = useRecentProfilesStore((state) => state.touchProfile);
  const [hostKeyDialog, setHostKeyDialog] =
    useState<SftpHostKeyDialogState>(CLOSED_DIALOG);

  const finishOpen = useCallback(
    (
      profile: ConnectionProfile,
      targetConnectionId?: string,
      targetSide: SftpSide = 'remote',
      initialDirectory?: string,
    ): void => {
      const connection = buildRemoteConnectionRequest(profile);
      const summary = {
        sessionId: generateId(),
        title: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
      };
      const ownerPrefix = targetConnectionId
        ? `sftp:${targetConnectionId}:${targetSide}:`
        : undefined;
      const releasedPreviousOwner = ownerPrefix
        ? usePortForwardStore.getState().stopOwnersByPrefix(ownerPrefix)
        : Promise.resolve();
      if (targetConnectionId) {
        attachRemoteConnection(targetConnectionId, targetSide, summary, connection, profile.id);
      } else {
        addConnection(summary, connection, profile.id);
      }
      const connectionId = targetConnectionId ?? useSftpStore.getState().activeConnectionId;
      if (connectionId) {
        if (initialDirectory) {
          useSftpStore.getState().setPath(connectionId, targetSide, initialDirectory);
        }
        void releasedPreviousOwner.then(() => usePortForwardStore
          .getState()
          .startAutoForOwner(profile, `sftp:${connectionId}:${targetSide}:${summary.sessionId}`));
        void hydrateSftpBookmarks(
          profile.host,
          profile.port,
          profile.username,
          connectionId,
          targetSide,
        );
      }
      touchProfile(profile.id);
      setActiveSection('sftp');
    },
    [addConnection, attachRemoteConnection, hydrateSftpBookmarks, setActiveSection, touchProfile],
  );

  const verifyHostKey = useCallback(
    async (host: string, port: number, onVerified: () => void): Promise<void> => {
      try {
        const result = await invokeCheckHostKey(host, port);

        if (result.status === 'match') {
          onVerified();
          return;
        }

        if (result.status === 'notFound' || result.status === 'mismatch') {
          setHostKeyDialog({
            open: true,
            host,
            port,
            fingerprint: result.fingerprint,
            mismatch: result.status === 'mismatch',
            onTrust: () => {
              void invokeTrustHost(host, port, result.fingerprint ?? '')
                .then(() => {
                  setHostKeyDialog(CLOSED_DIALOG);
                  onVerified();
                })
                .catch((error: unknown) => {
                  useToastStore
                    .getState()
                    .addToast(getToastErrorMessage(error), 'error');
                });
            },
          });
          return;
        }

        const detail =
          result.message ?? `Failed to check the host key for ${host}:${port}.`;
        logger.error('Host key check failed', detail);
        useToastStore
          .getState()
          .addToast(
            getToastErrorMessage(detail),
            'error',
          );
      } catch (error) {
        useToastStore
          .getState()
          .addToast(getToastErrorMessage(error), 'error');
      }
    },
    [],
  );

  const open = useCallback(
    async (
      profile: ConnectionProfile,
      targetConnectionId?: string,
      targetSide: SftpSide = 'remote',
      initialDirectory?: string,
    ) => {
      const profileWithSavedSecrets = await useProfileStore
        .getState()
        .ensurePassword(profile);
      const profileWithPassword = await promptForMissingPassword(profileWithSavedSecrets);
      if (!profileWithPassword) {
        return;
      }

      const profileWithKey = await ensureKeychainKeyForProfile(profileWithPassword);
      if (!profileWithKey) {
        return;
      }

      const preparedProfile = profileWithKey;

      // Persist a password entered via the prompt once the connection
      // succeeds; failures are swallowed inside persistPromptedPassword.
      const finish = (): void => {
        void persistPromptedPassword(profileWithSavedSecrets, preparedProfile);
        finishOpen(preparedProfile, targetConnectionId, targetSide, initialDirectory);
      };

      // Let the real pooled connection perform host-key verification,
      // authentication, and SFTP initialization on the same SSH session. This
      // avoids a separate host-key-only handshake for direct connections.
      const attemptSftpConnection = async () => {
        const request = buildRemoteConnectionRequest(preparedProfile);
        await invokeWarmRemoteConnection(request);
      };

      const handleRemoteFsError = (error: RemoteFsError): boolean => {
        if (error.type === 'HostKeyUnknown' || error.type === 'HostKeyMismatch') {
          setHostKeyDialog({
            open: true,
            host: error.payload.host,
            port: error.payload.port,
            fingerprint: error.payload.fingerprint,
            mismatch: error.type === 'HostKeyMismatch',
            onTrust: () => {
              void invokeTrustHost(
                error.payload.host,
                error.payload.port,
                error.payload.fingerprint ?? '',
              )
                .then(() => {
                  setHostKeyDialog(CLOSED_DIALOG);
                  return attemptSftpConnection();
                })
                .then(() => {
                  finish();
                })
                .catch((retryError: unknown) => {
                  const parsed = parseRemoteFsError(retryError);
                  if (parsed && handleRemoteFsError(parsed)) {
                    return;
                  }
                  useToastStore
                    .getState()
                    .addToast(getToastErrorMessage(retryError), 'error');
                });
            },
          });
          return true;
        }
        return false;
      };

      try {
        await attemptSftpConnection();
        finish();
      } catch (error) {
        const parsed = parseRemoteFsError(error);
        if (parsed && handleRemoteFsError(parsed)) {
          return;
        }
        useToastStore
          .getState()
          .addToast(getToastErrorMessage(error), 'error');
      }
    },
    [finishOpen],
  );

  const closeHostKeyDialog = (): void => {
    setHostKeyDialog(CLOSED_DIALOG);
  };

  return { open, verifyHostKey, hostKeyDialog, closeHostKeyDialog };
}
