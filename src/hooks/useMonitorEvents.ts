import { useEffect, useRef } from 'react';
import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';
import { useMonitorStore } from '@/stores/monitorStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { ClosedEvent, DisconnectEvent } from '@/types';
import { createLogger } from '@/lib/logger';
import { usePortForwardStore } from '@/stores/portForwardStore';

const logger = createLogger('monitor');

/**
 * Captures non-local terminal disconnects app-wide and records them in the
 * monitor store so the connection-health panel can show a bounded history.
 * Mounted once at the app root; runs for the lifetime of the app.
 */
export function useMonitorEvents(): void {
  const recordDisconnect = useMonitorStore((state) => state.recordDisconnect);
  const recordDisconnectRef = useRef(recordDisconnect);

  useEffect(() => {
    recordDisconnectRef.current = recordDisconnect;
  }, [recordDisconnect]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    const handleClosed = (event: Event<ClosedEvent>): void => {
      const payload = event.payload;
      void usePortForwardStore.getState().stopOwner(`terminal:${payload.sessionId}`);
      // A user-initiated close is not a monitored disconnect.
      if (payload.reasonKind === 'local_close') {
        return;
      }
      const session = useTerminalStore
        .getState()
        .sessions.find((s) => s.sessionId === payload.sessionId);
      // Prefer the identity the backend attached to the event (it survives even
      // after the session record is removed from the store); fall back to the
      // store lookup only as a defensive measure.
      const disconnect: DisconnectEvent = {
        sessionId: payload.sessionId,
        title: payload.identity?.title ?? session?.title,
        host: payload.identity?.host ?? session?.host,
        port: payload.identity?.port ?? session?.port,
        username: payload.identity?.username ?? session?.username,
        reasonKind: payload.reasonKind,
        reason: payload.reason,
        retryable: payload.retryable,
        at: Date.now(),
      };
      recordDisconnectRef.current(disconnect);
    };

    listen<ClosedEvent>('ssh-closed', handleClosed)
      .then((unlistenFn) => {
        if (disposed) {
          unlistenFn();
          return;
        }
        unlisten = unlistenFn;
      })
      .catch((error) => {
        logger.error('Failed to register ssh-closed listener', error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
