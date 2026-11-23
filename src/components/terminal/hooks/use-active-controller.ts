import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { useFocusStore } from '@/stores/focusStore';
import { agentTerminalLeaseState } from '../agent-terminal-lease-state';

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
  const attachedRef = useRef<{ controller: { host: HTMLElement | null; detach(): void }; host: HTMLElement } | null>(null);
  const focusEnabled = useFocusStore(state => state.enabled);
  const terminalOpen = useFocusStore(state => state.terminalOpen);
  const autoFocus = shouldFocus && shouldAttach && (!focusEnabled || terminalOpen);
  const focusTarget = useRef({ activeSessionId, autoFocus });
  focusTarget.current = { activeSessionId, autoFocus };
  const controller = useSyncExternalStore(terminalRegistry.subscribe, () =>
    activeSessionId === null ? undefined : terminalRegistry.get(activeSessionId),
  );

  // Attach only when the pane can be measured, in a layout effect so xterm
  // opens and fits its grid before the browser paints.
  useLayoutEffect(() => {
    const previous = attachedRef.current;
    if (previous !== null) {
      if (previous.controller.host === undefined || previous.controller.host === previous.host) {
        previous.controller.detach();
      }
      attachedRef.current = null;
    }

    const host = paneRef.current;
    if (!shouldAttach || activeSessionId === null || host === null) {
      return;
    }

    if (!controller) {
      return;
    }

    controller.attach(host);
    attachedRef.current = { controller, host };

    return () => {
      if (controller.host === undefined || controller.host === host) {
        controller.detach();
      }
      if (attachedRef.current?.controller === controller && attachedRef.current.host === host) {
        attachedRef.current = null;
      }
    };
  }, [activeSessionId, controller, paneRef, shouldAttach]);

  // Mode switches change both pane width and header height in one commit.
  // Fit before paint instead of displaying the previous grid for the resize debounce.
  useLayoutEffect(() => {
    if (shouldAttach && (!focusEnabled || terminalOpen)) controller?.fit();
  }, [controller, shouldAttach, focusEnabled, terminalOpen]);

  useEffect(() => {
    if (!autoFocus || activeSessionId === null || agentTerminalLeaseState.blocksUserInput(activeSessionId)) return;
    const focusedWhenScheduled = document.activeElement;
    const focusFrame = requestAnimationFrame(() => {
      if (!focusTarget.current.autoFocus || focusTarget.current.activeSessionId !== activeSessionId
        || agentTerminalLeaseState.blocksUserInput(activeSessionId)) return;
      // A user can enter a composer/search field after the selection commit
      // but before this frame. Preserve that newer editing intent. Moving
      // between actual terminal inputs still follows the selected session.
      const focused = document.activeElement;
      if (focused !== focusedWhenScheduled && focused instanceof HTMLElement
        && focused.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]')
        && !focused.closest('.xterm')
        && !paneRef.current?.contains(focused)) return;
      const active = terminalRegistry.get(activeSessionId);
      if (active?.host && active.terminal.textarea?.isConnected) active.focus();
    });
    return () => cancelAnimationFrame(focusFrame);
  }, [activeSessionId, autoFocus, paneRef]);

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
    controller?.searchAddon.clearSearch();
  }, [activeSessionId]);

  return { focus, searchNext, searchPrevious, clearSearch };
}
