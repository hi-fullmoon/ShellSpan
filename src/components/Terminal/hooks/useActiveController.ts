import { useCallback, useEffect, useRef } from 'react';
import { terminalRegistry } from '@/components/Terminal/registry/terminalRegistry';

export function useActiveController(
  paneRef: React.RefObject<HTMLDivElement | null>,
  activeSessionId: string | null,
): {
  searchNext: (query: string) => void;
  searchPrevious: (query: string) => void;
  clearSearch: () => void;
} {
  const attachedIdRef = useRef<string | null>(null);

  useEffect(() => {
    const attachedId = attachedIdRef.current;
    if (attachedId !== null) {
      const previous = terminalRegistry.get(attachedId);
      previous?.detach();
      attachedIdRef.current = null;
    }

    if (activeSessionId === null || paneRef.current === null) {
      return;
    }

    const controller = terminalRegistry.get(activeSessionId);
    if (!controller) {
      return;
    }

    controller.attach(paneRef.current);
    attachedIdRef.current = activeSessionId;

    return () => {
      const current = attachedIdRef.current;
      if (current === null) return;
      const c = terminalRegistry.get(current);
      c?.detach();
      attachedIdRef.current = null;
    };
  }, [activeSessionId, paneRef]);

  const searchNext = useCallback(
    (query: string) => {
      const controller =
        activeSessionId === null ? undefined : terminalRegistry.get(activeSessionId);
      controller?.searchAddon.findNext(query);
    },
    [activeSessionId],
  );

  const searchPrevious = useCallback(
    (query: string) => {
      const controller =
        activeSessionId === null ? undefined : terminalRegistry.get(activeSessionId);
      controller?.searchAddon.findPrevious(query);
    },
    [activeSessionId],
  );

  const clearSearch = useCallback(() => {
    const controller =
      activeSessionId === null ? undefined : terminalRegistry.get(activeSessionId);
    controller?.searchAddon.clearDecorations();
  }, [activeSessionId]);

  return { searchNext, searchPrevious, clearSearch };
}