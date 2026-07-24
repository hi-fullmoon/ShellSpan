import { useCallback, useState } from 'react';
import {
  buildRemoteConnectionRequest,
  invokeCheckHostKey,
  invokeListRemoteDirectory,
  invokeTrustHost,
  parseRemoteFsError,
} from '@/lib/tauri';
import { generateId } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { useSftpStore, type SftpSide } from '@/stores/sftpStore';
import { useToastStore } from '@/stores/toastStore';
import type { ConnectionProfile, RemoteFsError } from '@/types';
import { promptForMissingPassword } from '@/lib/password-prompt';
import { getLocalizedErrorMessage } from '@/lib/error';
import {
  ensureKeychainKeyForProfile,
  prepareKeychainKeyForProfile,
} from '@/lib/keychain-key-prompt';

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
  open: (profile: ConnectionProfile, targetConnectionId?: string, targetSide?: SftpSide) => Promise<void>;
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
    (profile: ConnectionProfile, targetConnectionId?: string, targetSide: SftpSide = 'remote'): void => {
      const connection = buildRemoteConnectionRequest(profile);
      const summary = {
        sessionId: generateId(),
        title: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
      };
      if (targetConnectionId) {
        attachRemoteConnection(targetConnectionId, targetSide, summary, connection, profile.id);
      } else {
        addConnection(summary, connection, profile.id);
      }
      const connectionId = targetConnectionId ?? useSftpStore.getState().activeConnectionId;
      if (connectionId) {
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
              void invokeTrustHost(host, port)
                .then(() => {
                  setHostKeyDialog(CLOSED_DIALOG);
                  onVerified();
                })
                .catch((error: unknown) => {
                  useToastStore
                    .getState()
                    .addToast(getLocalizedErrorMessage(error), 'error');
                });
            },
          });
          return;
        }

        useToastStore
          .getState()
          .addToast(result.message ?? `Failed to check the host key for ${host}:${port}.`, 'error');
      } catch (error) {
        useToastStore
          .getState()
          .addToast(getLocalizedErrorMessage(error), 'error');
      }
    },
    [],
  );

  const open = useCallback(
    async (profile: ConnectionProfile, targetConnectionId?: string, targetSide: SftpSide = 'remote') => {
      const profileWithPassword = await promptForMissingPassword(profile);
      if (!profileWithPassword) {
        return;
      }

      const profileWithKey = await ensureKeychainKeyForProfile(profileWithPassword);
      if (!profileWithKey) {
        return;
      }

      const preparedProfile = await prepareKeychainKeyForProfile(profileWithKey);
      if (!preparedProfile) {
        return;
      }

      // Non-jump-host sessions can be pre-probed with a direct TCP connection.
      if (!preparedProfile.jumpHost) {
        await verifyHostKey(
          preparedProfile.host,
          preparedProfile.port,
          () => finishOpen(preparedProfile, targetConnectionId, targetSide),
        );
        return;
      }

      // Jump-host sessions cannot be pre-probed from the frontend. We attempt
      // a lightweight SFTP operation so the backend can surface host-key errors.
      const attemptSftpConnection = async () => {
        const request = buildRemoteConnectionRequest(preparedProfile);
        await invokeListRemoteDirectory({ ...request });
      };

      const handleRemoteFsError = (error: RemoteFsError): boolean => {
        if (error.type === 'HostKeyUnknown' || error.type === 'HostKeyMismatch') {
          setHostKeyDialog({
            open: true,
            host: error.payload.host,
            port: error.payload.port,
            fingerprint: error.type === 'HostKeyUnknown' ? error.payload.fingerprint : undefined,
            mismatch: error.type === 'HostKeyMismatch',
            onTrust: () => {
              void invokeTrustHost(error.payload.host, error.payload.port)
                .then(() => {
                  setHostKeyDialog(CLOSED_DIALOG);
                  return attemptSftpConnection();
                })
                .then(() => {
                  finishOpen(preparedProfile, targetConnectionId, targetSide);
                })
                .catch((retryError: unknown) => {
                  const parsed = parseRemoteFsError(retryError);
                  if (parsed && handleRemoteFsError(parsed)) {
                    return;
                  }
                  useToastStore
                    .getState()
                    .addToast(getLocalizedErrorMessage(retryError), 'error');
                });
            },
          });
          return true;
        }
        return false;
      };

      try {
        await attemptSftpConnection();
        finishOpen(preparedProfile, targetConnectionId, targetSide);
      } catch (error) {
        const parsed = parseRemoteFsError(error);
        if (parsed && handleRemoteFsError(parsed)) {
          return;
        }
        useToastStore
          .getState()
          .addToast(getLocalizedErrorMessage(error), 'error');
      }
    },
    [finishOpen, verifyHostKey],
  );

  const closeHostKeyDialog = (): void => {
    setHostKeyDialog(CLOSED_DIALOG);
  };

  return { open, verifyHostKey, hostKeyDialog, closeHostKeyDialog };
}
