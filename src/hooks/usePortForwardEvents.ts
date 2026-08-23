import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { PortForwardRuntime } from '@/types';
import { usePortForwardStore } from '@/stores/portForwardStore';
import { createLogger } from '@/lib/logger';

const logger = createLogger('port-forward-events');

export function usePortForwardEvents(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void usePortForwardStore.getState().hydrate();
    listen<PortForwardRuntime>('port-forward-event', (event) => {
      usePortForwardStore.getState().applyRuntime(event.payload);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch((error) => {
      logger.error('Failed to register port forward event listener', error);
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
