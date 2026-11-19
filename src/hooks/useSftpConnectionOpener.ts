import { useCallback, useState } from 'react';
import {
  buildRemoteConnectionRequest,
  invokeTrustHost,
  invokeWarmRemoteConnection,
  parseRemoteFsError,
} from '@/lib/ipc/tauri';
import { generateId } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { useSftpStore, type SftpLocationRequest, type SftpSide } from '@/stores/sftpStore';
import { useToastStore } from '@/stores/toastStore';
import type { ConnectionProfile, RemoteConnectionRequest } from '@/types';
import { promptForMissingPassword, persistPromptedPassword } from '@/lib/connections/password-prompt';
import { getToastErrorMessage } from '@/lib/error';
import {
  ensureKeychainKeyForProfile,
} from '@/lib/connections/keychain-key-prompt';
import { useProfileStore } from '@/stores/profileStore';
import { usePortForwardStore } from '@/stores/portForwardStore';
import { sshRouteKey } from '@/lib/connections/ssh-route';
import { t } from '@/locales';

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
    initialDirectory?: string | SftpLocationRequest,
  ) => Promise<void>;
  verifyHostKey: (connection: RemoteConnectionRequest, onVerified: () => void) => Promise<void>;
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
      initialDirectory?: string | SftpLocationRequest,
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

  const showHostKeyError = useCallback((
    error: unknown,
    connection: RemoteConnectionRequest,
    retry: () => void | Promise<void>,
  ) => {
    const parsed = parseRemoteFsError(error);
    if (parsed?.type !== 'HostKeyUnknown' && parsed?.type !== 'HostKeyMismatch') {
      useToastStore.getState().addToast(getToastErrorMessage(error), 'error');
      return;
    }
    const { host, port, fingerprint } = parsed.payload;
    // When the failed key belongs to the jump host, that endpoint is reached directly.
    const jump = connection.jumpHost;
    const throughJump = jump && (host !== jump.host || port !== jump.port) ? jump : undefined;
    setHostKeyDialog({
      open: true,
      host,
      port,
      fingerprint,
      mismatch: parsed.type === 'HostKeyMismatch',
      onTrust: () => {
        const trust = throughJump
          ? invokeTrustHost(host, port, fingerprint ?? '', throughJump)
          : invokeTrustHost(host, port, fingerprint ?? '');
        void trust.then(() => {
          setHostKeyDialog(CLOSED_DIALOG);
          return retry();
        }).catch((trustError: unknown) => {
          useToastStore.getState().addToast(getToastErrorMessage(trustError), 'error');
        });
      },
    });
  }, []);

  const verifyHostKey = useCallback(async (
    connection: RemoteConnectionRequest,
    onVerified: () => void,
  ): Promise<void> => {
    const verify = async (): Promise<void> => {
      try {
        await invokeWarmRemoteConnection(connection);
        onVerified();
      } catch (error) {
        showHostKeyError(error, connection, verify);
      }
    };
    await verify();
  }, [showHostKeyError]);

  const open = useCallback(
    async (
      profile: ConnectionProfile,
      targetConnectionId?: string,
      targetSide: SftpSide = 'remote',
      initialDirectory?: string | SftpLocationRequest,
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
      let connectionAttemptId: string | undefined;
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
        if (typeof initialDirectory === 'object' && initialDirectory.routeKey !== sshRouteKey(preparedProfile)) {
          useToastStore.getState().addToast(t('ai.path.sftpRouteUnavailable'), 'error');
          return;
        }
        connectionAttemptId = beginAttempt(preparedProfile);
        setActiveSection('sftp');
        const connection = buildRemoteConnectionRequest(preparedProfile);

        const attemptSftpConnection = async (attemptId: string): Promise<void> => {
          try {
            // Let the real pooled connection perform host-key verification,
            // authentication, and SFTP initialization on the same SSH session.
            await invokeWarmRemoteConnection(connection);
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
            showHostKeyError(error, connection, async () => {
              const retryAttemptId = beginAttempt(preparedProfile);
              setActiveSection('sftp');
              try {
                await attemptSftpConnection(retryAttemptId);
              } finally {
                endConnectionAttempt(retryAttemptId);
              }
            });
          }
        };

        await attemptSftpConnection(connectionAttemptId);
      } finally {
        if (connectionAttemptId) endConnectionAttempt(connectionAttemptId);
      }
    },
    [beginConnectionAttempt, endConnectionAttempt, finishOpen, setActiveSection, showHostKeyError],
  );

  const closeHostKeyDialog = (): void => {
    setHostKeyDialog(CLOSED_DIALOG);
  };

  return { open, verifyHostKey, hostKeyDialog, closeHostKeyDialog };
}
