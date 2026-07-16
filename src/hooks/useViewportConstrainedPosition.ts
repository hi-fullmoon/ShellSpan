import { useLayoutEffect, useRef, useState } from 'react';

interface Position {
  left: number;
  top: number;
}

const DEFAULT_VIEWPORT_PADDING = 8;

export function getViewportConstrainedPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  padding = DEFAULT_VIEWPORT_PADDING,
): Position {
  const maxLeft = Math.max(padding, viewportWidth - width - padding);
  const maxTop = Math.max(padding, viewportHeight - height - padding);

  return {
    left: Math.max(padding, Math.min(x, maxLeft)),
    top: Math.max(padding, Math.min(y, maxTop)),
  };
}

export function useViewportConstrainedPosition<T extends HTMLElement>(
  open: boolean,
  x: number,
  y: number,
): { menuRef: React.RefObject<T | null>; position: Position } {
  const menuRef = useRef<T>(null);
  const [position, setPosition] = useState<Position>({ left: x, top: y });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;

    const updatePosition = (): void => {
      const rect = menu.getBoundingClientRect();
      const next = getViewportConstrainedPosition(
        x,
        y,
        rect.width,
        rect.height,
        window.innerWidth,
        window.innerHeight,
      );
      setPosition((current) =>
        current.left === next.left && current.top === next.top ? current : next,
      );
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(updatePosition);
    resizeObserver?.observe(menu);

    return () => {
      window.removeEventListener('resize', updatePosition);
      resizeObserver?.disconnect();
    };
  }, [open, x, y]);

  return { menuRef, position };
}
