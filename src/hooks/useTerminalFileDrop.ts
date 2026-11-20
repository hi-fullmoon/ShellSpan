import { useEffect, useRef } from 'react';
import { isTauriRuntime, listenToWindowDragDrop } from '@/lib/ipc/tauri';
import { useAppStore } from '@/stores/appStore';
import { createLogger } from '@/lib/logger';

const logger = createLogger('terminalFileDrop');

export function useTerminalFileDrop(
  area: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  onDrop: (sessionId: string, paths: string[]) => void,
): void {
  const handler = useRef(onDrop);
  handler.current = onDrop;
  useEffect(() => {
    if (!enabled || !isTauriRuntime()) return;
    let disposed = false;
    const subscription = listenToWindowDragDrop((payload) => {
      if (disposed || payload.type !== 'drop' || useAppStore.getState().activeSection !== 'terminal') return;
      const scale = window.devicePixelRatio || 1;
      const hit = document.elementFromPoint(payload.position.x / scale, payload.position.y / scale);
      const pane = hit?.closest<HTMLElement>('[data-terminal-pane-session]');
      const sessionId = pane?.dataset.terminalPaneSession;
      if (sessionId && pane && area.current?.contains(pane)) handler.current(sessionId, payload.paths);
    }).catch((error) => {
      logger.warn('Unable to listen for terminal file drops', error);
    });
    return () => {
      disposed = true;
      void subscription.then((unlisten) => unlisten?.());
    };
  }, [area, enabled]);
}
