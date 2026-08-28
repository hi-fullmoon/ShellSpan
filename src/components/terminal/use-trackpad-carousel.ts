import { useEffect, useRef, type RefObject } from 'react';

export type TerminalCarouselDirection = 'previous' | 'next';

interface UseTrackpadCarouselOptions {
  containerRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  canNavigate: (target: Element) => boolean;
  onNavigate: (direction: TerminalCarouselDirection, target: Element) => void;
}

// A deliberate two-finger swipe produces a short stream of pixel wheel events,
// followed by inertial events. Accumulate one gesture to a useful threshold and
// keep it locked until the stream goes idle so momentum cannot skip several tabs.
export const TRACKPAD_CAROUSEL_THRESHOLD_PX = 64;
export const TRACKPAD_CAROUSEL_IDLE_MS = 180;

const normalizeWheelDelta = (
  delta: number,
  deltaMode: number,
  pageSize: number,
): number => {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * 16;
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * pageSize;
  return delta;
};

export const useTrackpadCarousel = ({
  containerRef,
  enabled,
  canNavigate,
  onNavigate,
}: UseTrackpadCarouselOptions): void => {
  const canNavigateRef = useRef(canNavigate);
  const onNavigateRef = useRef(onNavigate);
  canNavigateRef.current = canNavigate;
  onNavigateRef.current = onNavigate;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    let accumulatedX = 0;
    let gestureLocked = false;
    let idleTimer: number | null = null;

    const finishGestureAfterIdle = (): void => {
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        accumulatedX = 0;
        gestureLocked = false;
        idleTimer = null;
      }, TRACKPAD_CAROUSEL_IDLE_MS);
    };

    const handleWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) return;

      const target = event.target instanceof Element
        ? event.target
        : event.target instanceof Node
          ? event.target.parentElement
          : null;
      const terminalContent = target?.closest('[data-terminal-content]');
      if (!target || !terminalContent || !container.contains(terminalContent)) return;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;

      const deltaX = normalizeWheelDelta(event.deltaX, event.deltaMode, container.clientWidth);
      const deltaY = normalizeWheelDelta(event.deltaY, event.deltaMode, container.clientHeight);

      // Leave vertical two-finger movement to xterm's scrollback. A small
      // dominance margin also filters the diagonal jitter of a vertical swipe.
      if (Math.abs(deltaX) < 2 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.1) return;
      if (!canNavigateRef.current(target)) return;

      event.preventDefault();
      event.stopPropagation();
      finishGestureAfterIdle();

      if (gestureLocked) return;
      if (accumulatedX !== 0 && Math.sign(accumulatedX) !== Math.sign(deltaX)) {
        accumulatedX = 0;
      }
      accumulatedX += deltaX;
      if (Math.abs(accumulatedX) < TRACKPAD_CAROUSEL_THRESHOLD_PX) return;

      gestureLocked = true;
      onNavigateRef.current(accumulatedX > 0 ? 'next' : 'previous', target);
    };

    // Capture before xterm handles wheel input. The listener must be non-passive
    // so a horizontal gesture does not leak into WebView navigation.
    container.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    return () => {
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      container.removeEventListener('wheel', handleWheel, true);
    };
  }, [containerRef, enabled]);
};
