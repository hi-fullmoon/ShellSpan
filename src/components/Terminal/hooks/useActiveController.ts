import { useCallback, useEffect, useRef } from 'react';
import { terminalRegistry } from '@/components/Terminal/registry/terminalRegistry';

interface SearchOptions {
  caseSensitive?: boolean;
}

export function useActiveController(
  paneRef: React.RefObject<HTMLDivElement | null>,
  activeSessionId: string | null,
): {
  focus: () => void;
  searchNext: (query: string, options?: SearchOptions) => void;
  searchPrevious: (query: string, options?: SearchOptions) => void;
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

    const focusFrame = requestAnimationFrame(() => {
      controller.focus();
    });

    return () => {
      cancelAnimationFrame(focusFrame);
      const current = attachedIdRef.current;
      if (current === null) return;
      const c = terminalRegistry.get(current);
      c?.detach();
      attachedIdRef.current = null;
    };
  }, [activeSessionId, paneRef]);

  const focus = useCallback(() => {
    if (activeSessionId === null) return;
    terminalRegistry.get(activeSessionId)?.focus();
  }, [activeSessionId]);

  const searchNext = useCallback(
    (query: string, options?: SearchOptions) => {
      const controller =
        activeSessionId === null ? undefined : terminalRegistry.get(activeSessionId);
      controller?.searchAddon.findNext(query, options);
    },
    [activeSessionId],
  );

  const searchPrevious = useCallback(
    (query: string, options?: SearchOptions) => {
      const controller =
        activeSessionId === null ? undefined : terminalRegistry.get(activeSessionId);
      controller?.searchAddon.findPrevious(query, options);
    },
    [activeSessionId],
  );

  const clearSearch = useCallback(() => {
    const controller =
      activeSessionId === null ? undefined : terminalRegistry.get(activeSessionId);
    controller?.searchAddon.clearDecorations();
  }, [activeSessionId]);

  return { focus, searchNext, searchPrevious, clearSearch };
}
