import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Let the existing scroller position the turn, using native smooth scrolling. */
export function useTurnScrollTransition(viewportRef: RefObject<HTMLDivElement | null>, anchorId?: string) {
  const previous = useRef(anchorId);
  useLayoutEffect(() => {
    const changed = previous.current !== anchorId;
    previous.current = anchorId;
    const viewport = viewportRef.current;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!changed || !anchorId || !viewport || motion.matches) return;

    const original = viewport.style.scrollBehavior;
    viewport.style.scrollBehavior = 'smooth';
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      viewport.style.scrollBehavior = original;
      window.clearTimeout(timeout);
    };
    const interrupt = () => {
      if (finished) return;
      const top = viewport.scrollTop;
      finish();
      // Cancel the browser's in-flight animation before applying user input.
      if (typeof viewport.scrollTo === 'function') {
        viewport.scrollTo({ top, behavior: 'instant' });
      } else {
        viewport.scrollTop = top;
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) interrupt();
    };
    const scrollEnd = () => {
      // A queued scrollend from the previous position may arrive just after
      // submission. Only finish when this turn has reached its destination.
      const item = Array.from(viewport.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find(element => element.dataset.messageId === anchorId);
      const content = item?.parentElement;
      if (!item || !content) return;
      const inset = Number.parseFloat(getComputedStyle(content).paddingBlockStart) || 0;
      if (Math.abs(item.getBoundingClientRect().top - viewport.getBoundingClientRect().top - inset) < 2) finish();
    };
    // scrollend restores immediate streaming follow. The timer also covers
    // no-op jumps and browsers without scrollend support.
    const timeout = window.setTimeout(interrupt, 1200);
    viewport.addEventListener('scrollend', scrollEnd);
    viewport.addEventListener('wheel', interrupt, { capture: true, passive: true });
    viewport.addEventListener('touchstart', interrupt, { capture: true, passive: true });
    viewport.addEventListener('pointerdown', interrupt, true);
    viewport.addEventListener('keydown', keyDown, true);
    window.addEventListener('resize', interrupt);
    motion.addEventListener('change', interrupt);
    return () => {
      interrupt();
      viewport.removeEventListener('scrollend', scrollEnd);
      viewport.removeEventListener('wheel', interrupt, true);
      viewport.removeEventListener('touchstart', interrupt, true);
      viewport.removeEventListener('pointerdown', interrupt, true);
      viewport.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('resize', interrupt);
      motion.removeEventListener('change', interrupt);
    };
  }, [anchorId, viewportRef]);
}
