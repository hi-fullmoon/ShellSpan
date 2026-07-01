import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { isTauriRuntime } from '../../../lib/tauri';

interface UseDragDropOptions {
  ready: boolean;
  currentPath?: string;
  ignoreWindowDragDrop?: boolean;
  loading: boolean;
  working: boolean;
  onUpload: (paths: string[]) => void;
}

export function useDragDrop({ ready, currentPath, ignoreWindowDragDrop, loading, working, onUpload }: UseDragDropOptions) {
  const [dragActive, setDragActive] = useState(false);
  const [localDragActive, setLocalDragActive] = useState(false);
  const latestStateRef = useRef({ ready, currentPath, ignoreWindowDragDrop, loading, working });

  latestStateRef.current = { ready, currentPath, ignoreWindowDragDrop, loading, working };

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let dispose: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      const unlisten = await getCurrentWindow().onDragDropEvent((event) => {
        const state = latestStateRef.current;
        const canProcess = state.ready && Boolean(state.currentPath) && !state.ignoreWindowDragDrop && !state.loading && !state.working;
        if (!canProcess) {
          setDragActive(false);
          return;
        }
        switch (event.payload.type) {
          case 'enter':
          case 'over':
            setDragActive(true);
            break;
          case 'leave':
            setDragActive(false);
            break;
          case 'drop':
            setDragActive(false);
            onUpload(event.payload.paths);
            break;
        }
      });
      if (cancelled) {
        unlisten();
        return;
      }
      dispose = unlisten;
    };

    void attach();
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [onUpload]);

  return {
    dragActive,
    setDragActive,
    localDragActive,
    setLocalDragActive,
  };
}
