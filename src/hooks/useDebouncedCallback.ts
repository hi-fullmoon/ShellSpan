import { useCallback, useRef } from 'react';

/**
 * Returns a debounced version of the callback that ignores calls within `delayMs`
 * of the previous invocation. Useful for preventing double-click triggers.
 *
 * Unlike a traditional trailing-edge debounce, this uses a leading-edge lock:
 * the first call executes immediately, and subsequent calls within the window
 * are silently ignored.
 */
export function useDebouncedCallback<T extends (...args: never[]) => void>(
  callback: T,
  delayMs = 300,
): T {
  const lastCallRef = useRef(0);

  return useCallback(
    (...args: Parameters<T>) => {
      const now = Date.now();
      if (now - lastCallRef.current < delayMs) {
        return;
      }
      lastCallRef.current = now;
      callback(...args);
    },
    [callback, delayMs],
  ) as T;
}
