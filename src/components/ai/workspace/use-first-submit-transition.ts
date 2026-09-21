import { useLayoutEffect, useRef } from 'react';

/** Animate only the layout change caused by submitting from the welcome screen. */
export function useFirstSubmitTransition(hero: boolean, pending = false, submissionContext?: object) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const origin = useRef<DOMRect | null>(null);
  const animations = useRef<Animation[]>([]);
  const context = useRef(submissionContext);

  const cancel = () => {
    animations.current.forEach(animation => animation.cancel());
    animations.current = [];
  };

  const prepare = () => {
    origin.current = hero
      ? bodyRef.current?.querySelector('[data-slot="ai-composer-seat"]')?.getBoundingClientRect() ?? null
      : null;
  };

  useLayoutEffect(() => {
    if (context.current !== submissionContext) {
      context.current = submissionContext;
      origin.current = null;
      cancel();
      return;
    }
    if (hero) {
      cancel();
      // Image submission can render several times before leaving the welcome
      // screen. Discard only when that attempt ends without a layout change.
      if (!pending) origin.current = null;
      return;
    }
    const previous = origin.current;
    origin.current = null;
    if (!previous || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const composer = bodyRef.current?.querySelector<HTMLElement>('[data-slot="ai-composer-seat"]');
    const content = bodyRef.current?.querySelector<HTMLElement>('[data-slot="ai-workspace-content"]');
    if (!composer?.animate) return;
    const current = composer.getBoundingClientRect();
    cancel();
    // The transcript gets its final height immediately, so its scroll anchor is
    // calculated once. Only translate the existing editor; never scale its text.
    animations.current.push(composer.animate([
      { transform: `translate(${previous.left - current.left}px, ${previous.top - current.top}px)` },
      { transform: 'translate(0, 0)' },
    ], { id: 'ai-first-submit-composer', duration: 280, easing: 'cubic-bezier(0.2, 0, 0, 1)' }));
    if (content) animations.current.push(content.animate([
      { opacity: 0 }, { opacity: 1 },
    ], { id: 'ai-first-submit-content', duration: 180, easing: 'ease-out' }));
  });

  useLayoutEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    motion.addEventListener('change', cancel);
    window.addEventListener('resize', cancel);
    return () => {
      cancel();
      motion.removeEventListener('change', cancel);
      window.removeEventListener('resize', cancel);
    };
  }, []);

  return { bodyRef, prepare };
}
