import type { SessionErrorEvent } from '@/types';
import { invokeTrustHost } from '@/lib/tauri';
import { useHostKeyDialogStore } from '@/stores/hostKeyDialogStore';
import { useToastStore } from '@/stores/toastStore';
import { getToastErrorMessage } from '@/lib/error';
import { createLogger } from '@/lib/logger';

const logger = createLogger('connect');

// Single-owner guard: only one HostKey prompt may be active per failing session.
const processingSessionErrors = new Set<string>();

interface HostKeyPromptOptions {
  host: string;
  port: number;
  fingerprint?: string;
  mismatch: boolean;
  /** Session that emitted ssh-session-error, when the prompt is event-driven. */
  errorSessionId?: string;
  /** Runs after the host key is trusted (retry the connect or reconnect the session). */
  onTrusted: () => void;
}

export function openHostKeyPrompt(options: HostKeyPromptOptions): void {
  const { host, port, fingerprint, mismatch, errorSessionId, onTrusted } = options;
  useHostKeyDialogStore.getState().openDialog(
    {
      host,
      port,
      fingerprint,
      mismatch,
      onTrust: () => {
        invokeTrustHost(host, port)
          .then(() => {
            useHostKeyDialogStore.getState().closeDialog();
            if (errorSessionId) processingSessionErrors.delete(errorSessionId);
            onTrusted();
          })
          .catch((error: unknown) => {
            if (errorSessionId) processingSessionErrors.delete(errorSessionId);
            useToastStore.getState().addToast(getToastErrorMessage(error), 'error');
          });
      },
    },
    errorSessionId ?? null,
  );
}

export function releaseSessionError(sessionId: string | null): void {
  if (sessionId) processingSessionErrors.delete(sessionId);
}

export function handleSessionErrorEvent(
  errorEvent: SessionErrorEvent,
  reconnect: (sessionId: string) => Promise<void>,
): void {
  if (errorEvent.type !== 'HostKeyUnknown' && errorEvent.type !== 'HostKeyMismatch') {
    return;
  }

  const { sessionId, host, port } = errorEvent.payload;

  // Guard against duplicate events for the same session or an already open dialog.
  if (processingSessionErrors.has(sessionId) || useHostKeyDialogStore.getState().dialog.open) {
    return;
  }
  processingSessionErrors.add(sessionId);

  const fingerprint = errorEvent.type === 'HostKeyUnknown' ? errorEvent.payload.fingerprint : undefined;

  logger.warn(
    `Host key verification prompt (${errorEvent.type}) for session ${sessionId} ${host}:${port}`,
  );

  openHostKeyPrompt({
    host,
    port,
    fingerprint,
    mismatch: errorEvent.type === 'HostKeyMismatch',
    errorSessionId: sessionId,
    onTrusted: () => {
      void reconnect(sessionId);
    },
  });
}
