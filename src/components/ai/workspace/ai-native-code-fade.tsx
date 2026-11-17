import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export function AiNativeCodeFade({ viewportRef, text }: {
  readonly viewportRef: RefObject<HTMLPreElement | null>;
  readonly text: string;
}) {
  const fadeRef = useRef<HTMLDivElement>(null);

  const updateVisibility = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const remaining = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    fadeRef.current?.toggleAttribute('hidden', remaining <= 1);
  }, [viewportRef]);

  const updateLayout = useCallback(() => {
    const viewport = viewportRef.current;
    const fade = fadeRef.current;
    if (!viewport || !fade) return;
    // Leave the native scrollbars outside the overlay.
    fade.style.right = `${viewport.offsetWidth - viewport.clientWidth}px`;
    fade.style.bottom = `${viewport.offsetHeight - viewport.clientHeight}px`;
    updateVisibility();
  }, [viewportRef, updateVisibility]);

  useLayoutEffect(updateLayout, [text, updateLayout]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(updateLayout);
    observer.observe(viewport);
    viewport.addEventListener('scroll', updateVisibility, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', updateVisibility);
    };
  }, [viewportRef, updateLayout, updateVisibility]);

  return <div ref={fadeRef} aria-hidden="true" hidden className="ai-native-code-fade pointer-events-none absolute left-0 h-8" />;
}
