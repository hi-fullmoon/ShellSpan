import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cn } from '../lib/ui';

type SplitDirection = 'horizontal' | 'vertical';

interface SplitLayoutProps {
  className?: string;
  defaultPrimarySize: number;
  direction?: SplitDirection;
  onPrimarySizeChange?: (size: number) => void;
  primary: ReactNode;
  primaryClassName?: string;
  primaryMaxSize?: number;
  primaryMinSize?: number;
  secondary: ReactNode;
  secondaryClassName?: string;
  secondaryMinSize?: number;
  storageKey?: string;
}

const SASH_SIZE = 10;

function readStoredSize(storageKey: string | undefined, fallback: number) {
  if (!storageKey || typeof window === 'undefined') {
    return fallback;
  }

  const raw = window.localStorage.getItem(storageKey);
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function SplitLayout({
  className,
  defaultPrimarySize,
  direction = 'horizontal',
  onPrimarySizeChange,
  primary,
  primaryClassName,
  primaryMaxSize,
  primaryMinSize = 240,
  secondary,
  secondaryClassName,
  secondaryMinSize = 320,
  storageKey,
}: SplitLayoutProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [primarySize, setPrimarySize] = useState(() => readStoredSize(storageKey, defaultPrimarySize));
  const [dragging, setDragging] = useState(false);

  const clampSize = (nextSize: number, containerSize: number) => {
    const available = Math.max(primaryMinSize, containerSize - secondaryMinSize - SASH_SIZE);
    const maxSize = primaryMaxSize !== undefined ? Math.min(primaryMaxSize, available) : available;
    return Math.max(primaryMinSize, Math.min(nextSize, maxSize));
  };

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      const containerSize =
        direction === 'horizontal' ? element.clientWidth : element.clientHeight;
      if (containerSize <= 0) {
        return;
      }

      setPrimarySize((current) => clampSize(current, containerSize));
    });

    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [direction, primaryMaxSize, primaryMinSize, secondaryMinSize]);

  useEffect(() => {
    if (storageKey && typeof window !== 'undefined') {
      window.localStorage.setItem(storageKey, String(primarySize));
    }
    onPrimarySizeChange?.(primarySize);
  }, [onPrimarySizeChange, primarySize, storageKey]);

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    event.preventDefault();

    const startPosition = direction === 'horizontal' ? event.clientX : event.clientY;
    const startSize = primarySize;
    const containerSize =
      direction === 'horizontal' ? element.clientWidth : element.clientHeight;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    setDragging(true);

    const handleMove = (moveEvent: PointerEvent) => {
      const currentPosition =
        direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
      const delta = currentPosition - startPosition;
      setPrimarySize(clampSize(startSize + delta, containerSize));
    };

    const stopDrag = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setDragging(false);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
  };

  const primaryStyle =
    direction === 'horizontal'
      ? { width: primarySize, minWidth: primarySize, maxWidth: primarySize }
      : { height: primarySize, minHeight: primarySize, maxHeight: primarySize };

  return (
    <div
      className={cn(
        'split-layout',
        direction === 'horizontal' ? 'flex h-full min-w-0 flex-1' : 'flex h-full min-h-0 flex-1 flex-col',
        className,
      )}
      ref={containerRef}
    >
      <div className={cn('grid h-full min-h-0 shrink-0 overflow-hidden', primaryClassName)} style={primaryStyle}>
        {primary}
      </div>

      <button
        aria-label={direction === 'horizontal' ? '调整左右区域宽度' : '调整上下区域高度'}
        className={cn(
          'split-sash',
          dragging && 'split-sash-active',
          direction === 'horizontal' ? 'split-sash-horizontal' : 'split-sash-vertical',
        )}
        onPointerDown={startDrag}
        type="button"
      >
        <span className="split-sash-line" />
      </button>

      <div className={cn('grid h-full min-h-0 min-w-0 flex-1 overflow-hidden', secondaryClassName)}>
        {secondary}
      </div>
    </div>
  );
}
