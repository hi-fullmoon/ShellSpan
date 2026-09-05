import React, { useEffect } from 'react';
import { listenToSessionError } from '@/lib/ipc/tauri';
import { useHostKeyDialogStore } from '@/stores/hostKeyDialogStore';
import { handleSessionErrorEvent, releaseSessionError } from '@/lib/host/host-key-prompt';
import { useReconnectSession } from '@/hooks/useReconnectSession';
import { createLogger } from '@/lib/logger';
import { HostKeyDialog } from './host-key-dialog';

const logger = createLogger('connect');

// Single owner of the HostKey confirmation flow: mounted once in App, it holds
// the only ssh-session-error subscription and renders the only dialog instance.
export const HostKeyDialogHost: React.FC = () => {
  const dialog = useHostKeyDialogStore((state) => state.dialog);
  const closeDialog = useHostKeyDialogStore((state) => state.closeDialog);
  const reconnect = useReconnectSession();

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    listenToSessionError((event) => {
      handleSessionErrorEvent(event.payload, reconnect);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch((error) => {
        logger.error('Failed to listen for session errors', error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [reconnect]);

  const handleClose = (): void => {
    releaseSessionError(useHostKeyDialogStore.getState().errorSessionId);
    closeDialog();
  };

  return (
    <HostKeyDialog
      open={dialog.open}
      onClose={handleClose}
      host={dialog.host}
      port={dialog.port}
      fingerprint={dialog.fingerprint}
      mismatch={dialog.mismatch}
      onTrust={dialog.onTrust}
    />
  );
};
