import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TerminalSession } from '@/stores/terminalStore';
import { TerminalPane } from './terminal-pane';

const TERMINAL_CAROUSEL_IDLE_MS = 100;
const TERMINAL_CAROUSEL_RENDER_RADIUS = 2;

interface TerminalCarouselProps {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  isActive: boolean;
  isVisible: boolean;
  onActivate: (sessionId: string) => void;
  onSettle: (sessionId: string) => void;
}

const getViewportWidth = (viewport: HTMLElement): number => (
  viewport.clientWidth || viewport.getBoundingClientRect().width || 1
);

const getNearestIndex = (
  viewport: HTMLElement,
  sessionCount: number,
): number => {
  const width = getViewportWidth(viewport);
  return Math.max(0, Math.min(Math.round(viewport.scrollLeft / width), sessionCount - 1));
};

const getNearbySessionIds = (
  sessions: TerminalSession[],
  centerIndex: number,
): Set<string> => new Set(
  sessions
    .slice(
      Math.max(0, centerIndex - TERMINAL_CAROUSEL_RENDER_RADIUS),
      centerIndex + TERMINAL_CAROUSEL_RENDER_RADIUS + 1,
    )
    .map((session) => session.sessionId),
);

const getActiveSessionIds = (
  sessions: TerminalSession[],
  activeIndex: number,
): Set<string> => {
  const sessionId = sessions[activeIndex]?.sessionId;
  return new Set(sessionId ? [sessionId] : []);
};

/**
 * A native horizontal scroll viewport gives WKWebView ownership of trackpad
 * phases, momentum, interruption, rubber-banding, and scroll snapping. The
 * app only mirrors the nearest page into terminal state.
 */
export const TerminalCarousel: React.FC<TerminalCarouselProps> = ({
  sessions,
  activeSessionId,
  isActive,
  isVisible,
  onActivate,
  onSettle,
}) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef(false);
  const reportedIndexRef = useRef(0);
  const idleTimerRef = useRef<number | null>(null);
  const sessionsRef = useRef(sessions);
  const onActivateRef = useRef(onActivate);
  const onSettleRef = useRef(onSettle);
  sessionsRef.current = sessions;
  onActivateRef.current = onActivate;
  onSettleRef.current = onSettle;

  const activeIndex = Math.max(
    0,
    sessions.findIndex((session) => session.sessionId === activeSessionId),
  );
  const sessionKey = useMemo(
    () => sessions.map((session) => session.sessionId).join('\0'),
    [sessions],
  );
  const [mountedSessionIds, setMountedSessionIds] = useState(() => (
    getActiveSessionIds(sessions, activeIndex)
  ));

  const expandMountedWindow = (centerIndex: number): void => {
    const nearbyIds = getNearbySessionIds(sessionsRef.current, centerIndex);
    setMountedSessionIds((current) => {
      if ([...nearbyIds].every((sessionId) => current.has(sessionId))) return current;
      return new Set([...current, ...nearbyIds]);
    });
  };

  const finishInteraction = (): void => {
    const viewport = viewportRef.current;
    const currentSessions = sessionsRef.current;
    if (!viewport || currentSessions.length === 0) return;

    interactionRef.current = false;
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    const settledIndex = getNearestIndex(viewport, currentSessions.length);
    const settledSession = currentSessions[settledIndex];
    reportedIndexRef.current = settledIndex;
    setMountedSessionIds(getActiveSessionIds(currentSessions, settledIndex));
    if (!settledSession) return;
    onActivateRef.current(settledSession.sessionId);
    onSettleRef.current(settledSession.sessionId);
  };

  const scheduleInteractionFinish = (): void => {
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(
      finishInteraction,
      TERMINAL_CAROUSEL_IDLE_MS,
    );
  };

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || interactionRef.current) return;
    reportedIndexRef.current = activeIndex;
    viewport.scrollLeft = activeIndex * getViewportWidth(viewport);
    setMountedSessionIds(getActiveSessionIds(sessions, activeIndex));
  }, [activeIndex, sessionKey, sessions]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey) return;
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || Math.abs(event.deltaX) < 0.05) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('button, a[href], input, textarea, select, [contenteditable="true"]')) {
        return;
      }

      // Keep xterm from treating horizontal movement as scrollback input, but
      // do not cancel the event: WKWebView performs the native horizontal
      // scroll, including momentum and interruption, on this viewport.
      event.stopPropagation();
      interactionRef.current = true;
      expandMountedWindow(getNearestIndex(viewport, sessionsRef.current.length));
      scheduleInteractionFinish();
    };

    const handleScroll = (): void => {
      const currentSessions = sessionsRef.current;
      if (currentSessions.length === 0) return;
      interactionRef.current = true;
      const nearestIndex = getNearestIndex(viewport, currentSessions.length);
      expandMountedWindow(nearestIndex);
      if (nearestIndex !== reportedIndexRef.current) {
        reportedIndexRef.current = nearestIndex;
        const session = currentSessions[nearestIndex];
        if (session) onActivateRef.current(session.sessionId);
      }
      scheduleInteractionFinish();
    };

    viewport.addEventListener('wheel', handleWheel, { capture: true, passive: true });
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    viewport.addEventListener('scrollend', finishInteraction);
    return () => {
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
      viewport.removeEventListener('wheel', handleWheel, true);
      viewport.removeEventListener('scroll', handleScroll);
      viewport.removeEventListener('scrollend', finishInteraction);
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (interactionRef.current) return;
      viewport.scrollLeft = reportedIndexRef.current * getViewportWidth(viewport);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={viewportRef}
      data-terminal-carousel
      data-carousel-active-index={reportedIndexRef.current}
      className="absolute inset-0 flex snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {sessions.map((session) => {
        const active = session.sessionId === activeSessionId;
        return (
          <div
            key={session.sessionId}
            data-terminal-carousel-page={session.sessionId}
            aria-hidden={!active}
            inert={!active}
            className="relative h-full w-full shrink-0 snap-start overflow-hidden bg-app-bg"
          >
            {mountedSessionIds.has(session.sessionId) && (
              <TerminalPane
                activeSession={session}
                isActive={isActive && active}
                isVisible={isVisible}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
