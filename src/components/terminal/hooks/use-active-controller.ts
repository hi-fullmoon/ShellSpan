import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';

interface SearchOptions {
  caseSensitive?: boolean;
}

export function useActiveController(
  paneRef: React.RefObject<HTMLDivElement | null>,
  activeSessionId: string | null,
  shouldFocus = true,
  shouldAttach = true,
): {
  focus: () => void;
  searchNext: (query: string, options?: SearchOptions) => void;
  searchPrevious: (query: string, options?: SearchOptions) => void;
  clearSearch: () => void;
} {
  const attachedIdRef = useRef<string | null>(null);
  const controller = useSyncExternalStore(terminalRegistry.subscribe, () =>
    activeSessionId === null ? undefined : terminalRegistry.get(activeSessionId),
  );

  // Opening xterm under a display:none ancestor gives its renderer a zero-size
  // canvas. The first visible frame can then stretch that stale canvas before
  // fit() corrects it, which briefly renders the terminal at a huge scale.
  // Attach only while the terminal section is visible, and do it in a layout
  // effect so open() and the initial fit complete before the browser paints.
  useLayoutEffect(() => {
    const attachedId = attachedIdRef.current;
    if (attachedId !== null) {
      const previous = terminalRegistry.get(attachedId);
      previous?.detach();
      attachedIdRef.current = null;
    }

    if (!shouldAttach || activeSessionId === null || paneRef.current === null) {
      return;
    }

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
  }, [activeSessionId, controller, paneRef, shouldAttach]);

  useEffect(() => {
    if (!shouldFocus || activeSessionId === null) return;
    const focusFrame = requestAnimationFrame(() => {
      terminalRegistry.get(activeSessionId)?.focus();
    });
    return () => cancelAnimationFrame(focusFrame);
  }, [activeSessionId, shouldFocus]);

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
