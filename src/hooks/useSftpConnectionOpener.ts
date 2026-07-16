import { useCallback, useState } from 'react';
import {
  buildRemoteConnectionRequest,
  invokeCheckHostKey,
  invokeTrustHost,
} from '@/lib/tauri';
import { generateId } from '@/lib/utils';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { useSftpStore } from '@/stores/sftpStore';
import { useToastStore } from '@/stores/toastStore';
import type { ConnectionProfile } from '@/types';

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
  open: (profile: ConnectionProfile) => Promise<void>;
  verifyHostKey: (host: string, port: number, onVerified: () => void) => Promise<void>;
  hostKeyDialog: SftpHostKeyDialogState;
  closeHostKeyDialog: () => void;
} {
  const ensurePassword = useProfileStore((state) => state.ensurePassword);
  const addConnection = useSftpStore((state) => state.addConnection);
  const setActiveSection = useAppStore((state) => state.setActiveSection);
  const touchProfile = useRecentProfilesStore((state) => state.touchProfile);
  const [hostKeyDialog, setHostKeyDialog] =
    useState<SftpHostKeyDialogState>(CLOSED_DIALOG);

  const finishOpen = useCallback(
    (profile: ConnectionProfile): void => {
      const connection = buildRemoteConnectionRequest(profile);
      const summary = {
        sessionId: generateId(),
        title: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
      };
      addConnection(summary, connection, profile.id);
      touchProfile(profile.id);
      setActiveSection('sftp');
    },
    [addConnection, setActiveSection, touchProfile],
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
    async (profile: ConnectionProfile) => {
      const profileWithPassword = await ensurePassword(profile);

      // The current host-key probe opens a direct TCP connection. Jump-host
      // sessions are still verified by the backend while establishing SFTP.
      if (profileWithPassword.jumpHost) {
        finishOpen(profileWithPassword);
        return;
      }

      await verifyHostKey(
        profileWithPassword.host,
        profileWithPassword.port,
        () => finishOpen(profileWithPassword),
      );
    },
    [ensurePassword, finishOpen, verifyHostKey],
  );

  const closeHostKeyDialog = (): void => {
    setHostKeyDialog(CLOSED_DIALOG);
  };

  return { open, verifyHostKey, hostKeyDialog, closeHostKeyDialog };
}
