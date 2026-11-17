import { createLogger } from '@/lib/logger';
import { invokeCancelPendingSshConnection, invokeCloseSession, invokeCreateSession } from '@/lib/ipc/tauri';
import type { SessionCreateRequest, SessionSummary } from '@/types';

const logger = createLogger('ssh-connect');
const pending = new Map<string, AbortController>();

/** A tab owns its retries until it publishes a replacement or is cancelled. */
export function beginSshConnection(ownerId: string, kind: 'new' | 'replacement' = 'new') {
  const controller = new AbortController();
  const { signal } = controller;
  pending.set(ownerId, controller);

  return {
    signal,
    async connect(request: SessionCreateRequest): Promise<SessionSummary | null> {
      if (signal.aborted) return null;
      let transportId: string | undefined;
      let cancellation: Promise<boolean> | undefined;
      const cancelTransport = (): Promise<boolean> | undefined => {
        if (!transportId) return undefined;
        return cancellation ??= invokeCancelPendingSshConnection(transportId).catch((error: unknown) => {
          logger.warn('Could not cancel a pending SSH transport', error);
          return false;
        });
      };
      const abort = (): void => { void cancelTransport(); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const summary = await invokeCreateSession(request, undefined, (id) => {
          transportId = id;
          if (signal.aborted) void cancelTransport();
        });
        if (!signal.aborted) return summary;
        transportId = summary.sessionId;
        if (await cancelTransport()) return null;
        // Once the replacement is ready, its predecessor may already have
        // retired. Adopt the committed summary; a removed tab will close it.
        if (kind === 'replacement') return summary;
        await invokeCloseSession(summary.sessionId).catch((error: unknown) => {
          logger.warn('Could not close an unwanted SSH transport', error);
        });
        return null;
      } catch (error) {
        if (!signal.aborted) throw error;
        await cancelTransport();
        return null;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
    finish(): void {
      if (pending.get(ownerId) === controller) pending.delete(ownerId);
    },
  };
}

export function cancelSshConnection(ownerId: string): void {
  pending.get(ownerId)?.abort();
}
