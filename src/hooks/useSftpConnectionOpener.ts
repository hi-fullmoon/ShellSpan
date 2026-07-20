import { useCallback, useState } from 'react';
import {
  buildRemoteConnectionRequest,
  invokeCheckHostKey,
  invokeTrustHost,
} from '@/lib/tauri';
import { generateId } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { useSftpStore, type SftpSide } from '@/stores/sftpStore';
import { useToastStore } from '@/stores/toastStore';
import type { ConnectionProfile } from '@/types';
import { promptForMissingPassword } from '@/lib/password-prompt';

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
      touchProfile(profile.id);
      setActiveSection('sftp');
    },
    [addConnection, attachRemoteConnection, setActiveSection, touchProfile],
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
                    .addToast(error instanceof Error ? error.message : String(error), 'error');
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
          .addToast(error instanceof Error ? error.message : String(error), 'error');
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

      // The current host-key probe opens a direct TCP connection. Jump-host
      // sessions are still verified by the backend while establishing SFTP.
      if (profileWithPassword.jumpHost) {
        finishOpen(profileWithPassword, targetConnectionId, targetSide);
        return;
      }

      await verifyHostKey(
        profileWithPassword.host,
        profileWithPassword.port,
        () => finishOpen(profileWithPassword, targetConnectionId, targetSide),
      );
    },
    [finishOpen, verifyHostKey],
  );

  const closeHostKeyDialog = (): void => {
    setHostKeyDialog(CLOSED_DIALOG);
  };

  return { open, verifyHostKey, hostKeyDialog, closeHostKeyDialog };
}
