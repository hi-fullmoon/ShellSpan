import { useCallback, useState } from 'react';
import {
  buildRemoteConnectionRequest,
  invokeCheckHostKey,
  invokeTrustHost,
  invokeWarmRemoteConnection,
  parseRemoteFsError,
} from '@/lib/ipc/tauri';
import { generateId } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { useSftpStore, type SftpSide } from '@/stores/sftpStore';
import { useToastStore } from '@/stores/toastStore';
import type { ConnectionProfile } from '@/types';
import { promptForMissingPassword, persistPromptedPassword } from '@/lib/connections/password-prompt';
import { getToastErrorMessage } from '@/lib/error';
import { createLogger } from '@/lib/logger';
import {
  ensureKeychainKeyForProfile,
} from '@/lib/connections/keychain-key-prompt';
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
  const beginConnectionAttempt = useSftpStore((state) => state.beginConnectionAttempt);
  const resolveConnectionAttempt = useSftpStore((state) => state.resolveConnectionAttempt);
  const endConnectionAttempt = useSftpStore((state) => state.endConnectionAttempt);
  const hydrateSftpBookmarks = useSftpStore((state) => state.hydrateSftpBookmarks);
  const setActiveSection = useAppStore((state) => state.setActiveSection);
  const touchProfile = useRecentProfilesStore((state) => state.touchProfile);
  const [hostKeyDialog, setHostKeyDialog] =
    useState<SftpHostKeyDialogState>(CLOSED_DIALOG);

  const finishOpen = useCallback(
    (
      attemptId: string,
      profile: ConnectionProfile,
      targetConnectionId?: string,
      targetSide: SftpSide = 'remote',
      initialDirectory?: string,
    ): boolean => {
      const connection = buildRemoteConnectionRequest(profile);
      const summary = {
        sessionId: generateId(),
        title: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
      };
      const connectionId = resolveConnectionAttempt(
        attemptId,
        summary,
        connection,
        profile.id,
        initialDirectory,
      );
      if (!connectionId) return false;
      const ownerPrefix = targetConnectionId
        ? `sftp:${targetConnectionId}:${targetSide}:`
        : undefined;
      const releasedPreviousOwner = ownerPrefix
        ? usePortForwardStore.getState().stopOwnersByPrefix(ownerPrefix)
        : Promise.resolve();
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
      touchProfile(profile.id);
      return true;
    },
    [hydrateSftpBookmarks, resolveConnectionAttempt, touchProfile],
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
      const beginAttempt = (attemptProfile: ConnectionProfile): string =>
        beginConnectionAttempt({
          title: attemptProfile.name,
          host: attemptProfile.host,
          port: attemptProfile.port,
          username: attemptProfile.username,
          profileId: attemptProfile.id,
          connection: buildRemoteConnectionRequest(attemptProfile),
        }, targetConnectionId, targetSide);
      const connectionAttemptId = beginAttempt(profile);
      setActiveSection('sftp');
      try {
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

        const attemptSftpConnection = async (attemptId: string): Promise<void> => {
          try {
            // Let the real pooled connection perform host-key verification,
            // authentication, and SFTP initialization on the same SSH session.
            await invokeWarmRemoteConnection(buildRemoteConnectionRequest(preparedProfile));
            if (finishOpen(
              attemptId,
              preparedProfile,
              targetConnectionId,
              targetSide,
              initialDirectory,
            )) {
              // Failures are swallowed inside persistPromptedPassword.
              void persistPromptedPassword(profileWithSavedSecrets, preparedProfile);
            }
          } catch (error) {
            const parsed = parseRemoteFsError(error);
            if (parsed && (
              parsed.type === 'HostKeyUnknown'
              || parsed.type === 'HostKeyMismatch'
            )) {
              setHostKeyDialog({
                open: true,
                host: parsed.payload.host,
                port: parsed.payload.port,
                fingerprint: parsed.payload.fingerprint,
                mismatch: parsed.type === 'HostKeyMismatch',
                onTrust: () => {
                  void invokeTrustHost(
                    parsed.payload.host,
                    parsed.payload.port,
                    parsed.payload.fingerprint ?? '',
                  )
                    .then(async () => {
                      setHostKeyDialog(CLOSED_DIALOG);
                      const retryAttemptId = beginAttempt(preparedProfile);
                      setActiveSection('sftp');
                      try {
                        await attemptSftpConnection(retryAttemptId);
                      } finally {
                        endConnectionAttempt(retryAttemptId);
                      }
                    })
                    .catch((retryError: unknown) => {
                      useToastStore
                        .getState()
                        .addToast(getToastErrorMessage(retryError), 'error');
                    });
                },
              });
              return;
            }
            useToastStore
              .getState()
              .addToast(getToastErrorMessage(error), 'error');
          }
        };

        await attemptSftpConnection(connectionAttemptId);
      } finally {
        endConnectionAttempt(connectionAttemptId);
      }
    },
    [beginConnectionAttempt, endConnectionAttempt, finishOpen, setActiveSection],
  );

  const closeHostKeyDialog = (): void => {
    setHostKeyDialog(CLOSED_DIALOG);
  };

  return { open, verifyHostKey, hostKeyDialog, closeHostKeyDialog };
}
