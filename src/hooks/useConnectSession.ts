import { useRef, useState } from 'react';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import type { ConnectionProfile } from '@/types';
import {
  buildSessionCreateRequest,
  invokeCreateLocalSession,
  invokeCreateSession,
  invokeTrustHost,
} from '@/lib/tauri';
import { useToastStore } from '@/stores/toastStore';
import { createLogger } from '@/lib/logger';
import { promptForMissingPassword } from '@/lib/password-prompt';

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

  const [hostKeyDialog, setHostKeyDialog] = useState<HostKeyDialogState>(CLOSED_DIALOG);
  const pendingProfileRef = useRef<ConnectionProfile | null>(null);

  const connect = async (
    profile: ConnectionProfile,
    options?: { insertAfterId?: string; pinned?: boolean; color?: string },
  ): Promise<void> => {
    logger.info(`Connecting to ${profile.host}:${profile.port} as ${profile.username}`);
    const profileWithPassword = await promptForMissingPassword(profile);
    if (!profileWithPassword) {
      logger.info('Connection cancelled by user (password dialog dismissed)');
      return;
    }
    pendingProfileRef.current = profileWithPassword;
    try {
      const summary = await invokeCreateSession(
        buildSessionCreateRequest(profileWithPassword, 120, 30),
      );
      addSession(summary, profile.id, options);
      logger.info(`Connected to ${profile.host}:${profile.port} (session ${summary.sessionId})`);
      useRecentProfilesStore.getState().touchProfile(profile.id);
      setActiveSection('terminal');
    } catch (error) {
      handleConnectionError(error, () => {
        const pending = pendingProfileRef.current;
        if (pending) {
          void connect(pending, options);
        }
      });
    }
  };

  const openLocal = async (): Promise<void> => {
    try {
      const summary = await invokeCreateLocalSession();
      addSession(summary);
      setActiveSection('terminal');
    } catch (error) {
      useToastStore.getState().addToast(
        error instanceof Error ? error.message : String(error),
        'error',
      );
    }
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
    useToastStore
      .getState()
      .addToast(error instanceof Error ? error.message : String(error), 'error');
    logger.error('Connection failed', error);
  };

  const closeHostKeyDialog = (): void => {
    setHostKeyDialog(CLOSED_DIALOG);
  };

  return {
    connect,
    openLocal,
    hostKeyDialog,
    closeHostKeyDialog,
  };
}
