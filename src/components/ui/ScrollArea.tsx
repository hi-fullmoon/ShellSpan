import {
  type CSSProperties,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
  type UIEventHandler,
} from 'react';
import { cn } from '../../lib/ui';

type ScrollAreaOrientation = 'vertical' | 'horizontal' | 'both';
type ScrollAreaScrollbar = 'default' | 'hover';

interface ScrollMetrics {
  hasHorizontalOverflow: boolean;
  hasVerticalOverflow: boolean;
  horizontalThumbOffset: number;
  horizontalThumbSize: number;
  verticalThumbOffset: number;
  verticalThumbSize: number;
}

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: ScrollAreaOrientation;
  scrollbar?: ScrollAreaScrollbar;
  scrollbarSize?: number;
}

const viewportOrientationClassName: Record<ScrollAreaOrientation, string> = {
  vertical: 'overflow-x-hidden overflow-y-auto',
  horizontal: 'overflow-x-auto overflow-y-hidden',
  both: 'overflow-auto',
};

const MIN_THUMB_SIZE = 24;
const TRACK_MAIN_AXIS_INSET = 6;

const defaultMetrics: ScrollMetrics = {
  hasHorizontalOverflow: false,
  hasVerticalOverflow: false,
  horizontalThumbOffset: 0,
  horizontalThumbSize: MIN_THUMB_SIZE,
  verticalThumbOffset: 0,
  verticalThumbSize: MIN_THUMB_SIZE,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function getThumbMetrics(scrollSize: number, viewportSize: number, scrollOffset: number, trackSize = viewportSize) {
  if (scrollSize <= viewportSize || viewportSize <= 0 || trackSize <= 0) {
    return {
      hasOverflow: false,
      offset: 0,
      size: MIN_THUMB_SIZE,
    };
  }

  const size = Math.max(MIN_THUMB_SIZE, (viewportSize / scrollSize) * trackSize);
  const maxOffset = Math.max(0, trackSize - size);
  const maxScrollOffset = Math.max(1, scrollSize - viewportSize);
  return {
    hasOverflow: true,
    offset: (scrollOffset / maxScrollOffset) * maxOffset,
    size,
  };
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { children, className, onMouseEnter, onMouseLeave, onScroll, orientation = 'vertical', scrollbar = 'default', scrollbarSize, style, ...props },
  ref,
) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const verticalTrackRef = useRef<HTMLDivElement | null>(null);
  const horizontalTrackRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const draggingScrollbarRef = useRef(false);
  const [scrollbarVisible, setScrollbarVisible] = useState(scrollbar !== 'hover');
  const [metrics, setMetrics] = useState<ScrollMetrics>(defaultMetrics);

  useImperativeHandle(ref, () => viewportRef.current as HTMLDivElement);

  const syncMetrics = () => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const horizontalTrackSize = Math.max(0, viewport.clientWidth - TRACK_MAIN_AXIS_INSET * 2);
    const verticalTrackSize = Math.max(0, viewport.clientHeight - TRACK_MAIN_AXIS_INSET * 2);
    const horizontal = getThumbMetrics(viewport.scrollWidth, viewport.clientWidth, viewport.scrollLeft, horizontalTrackSize);
    const vertical = getThumbMetrics(viewport.scrollHeight, viewport.clientHeight, viewport.scrollTop, verticalTrackSize);

    setMetrics((current) => {
      const next: ScrollMetrics = {
        hasHorizontalOverflow: horizontal.hasOverflow,
        hasVerticalOverflow: vertical.hasOverflow,
        horizontalThumbOffset: horizontal.offset,
        horizontalThumbSize: horizontal.size,
        verticalThumbOffset: vertical.offset,
        verticalThumbSize: vertical.size,
      };

      if (
        current.hasHorizontalOverflow === next.hasHorizontalOverflow &&
        current.hasVerticalOverflow === next.hasVerticalOverflow &&
        Math.abs(current.horizontalThumbOffset - next.horizontalThumbOffset) < 0.5 &&
        Math.abs(current.horizontalThumbSize - next.horizontalThumbSize) < 0.5 &&
        Math.abs(current.verticalThumbOffset - next.verticalThumbOffset) < 0.5 &&
        Math.abs(current.verticalThumbSize - next.verticalThumbSize) < 0.5
      ) {
        return current;
      }

      return next;
    });
  };

  const scheduleSyncMetrics = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = undefined;
      syncMetrics();
    });
  };

  useLayoutEffect(() => {
    scheduleSyncMetrics();

    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      scheduleSyncMetrics();
    });
    resizeObserver.observe(viewport);

    const mutationObserver = new MutationObserver(() => {
      scheduleSyncMetrics();
    });
    mutationObserver.observe(viewport, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = undefined;
      }
    };
  }, [children, orientation]);

  useEffect(() => {
    setScrollbarVisible(scrollbar !== 'hover');
  }, [scrollbar]);

  useEffect(() => {
    scheduleSyncMetrics();
  }, [scrollbar, children, orientation]);

  const handleMouseEnter: MouseEventHandler<HTMLDivElement> = (event) => {
    if (scrollbar === 'hover') {
      setScrollbarVisible(true);
    }
    onMouseEnter?.(event);
  };

  const handleMouseLeave: MouseEventHandler<HTMLDivElement> = (event) => {
    if (scrollbar === 'hover' && !draggingScrollbarRef.current) {
      setScrollbarVisible(false);
    }
    onMouseLeave?.(event);
  };

  const handleScroll: UIEventHandler<HTMLDivElement> = (event) => {
    scheduleSyncMetrics();
    onScroll?.(event);
  };

  const scrollToTrackPosition = (axis: 'horizontal' | 'vertical', clientOffset: number) => {
    const viewport = viewportRef.current;
    const track = axis === 'horizontal' ? horizontalTrackRef.current : verticalTrackRef.current;
    if (!viewport || !track) {
      return;
    }

    const rect = track.getBoundingClientRect();
    const trackSize = axis === 'horizontal' ? rect.width : rect.height;
    const scrollSize = axis === 'horizontal' ? viewport.scrollWidth : viewport.scrollHeight;
    const clientSize = axis === 'horizontal' ? viewport.clientWidth : viewport.clientHeight;
    const thumbSize = axis === 'horizontal' ? metrics.horizontalThumbSize : metrics.verticalThumbSize;
    const maxThumbOffset = Math.max(0, trackSize - thumbSize);
    const nextThumbOffset = clamp(clientOffset - thumbSize / 2, 0, maxThumbOffset);
    const nextScrollOffset = maxThumbOffset > 0 ? (nextThumbOffset / maxThumbOffset) * (scrollSize - clientSize) : 0;

    if (axis === 'horizontal') {
      viewport.scrollLeft = nextScrollOffset;
    } else {
      viewport.scrollTop = nextScrollOffset;
    }
  };

  const handleTrackPointerDown = (axis: 'horizontal' | 'vertical') => (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }

    const track = axis === 'horizontal' ? horizontalTrackRef.current : verticalTrackRef.current;
    if (!track) {
      return;
    }

    const rect = track.getBoundingClientRect();
    scrollToTrackPosition(axis, axis === 'horizontal' ? event.clientX - rect.left : event.clientY - rect.top);
  };

  const handleThumbPointerDown = (axis: 'horizontal' | 'vertical') => (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    const track = axis === 'horizontal' ? horizontalTrackRef.current : verticalTrackRef.current;
    if (!viewport || !track) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    draggingScrollbarRef.current = true;
    if (scrollbar === 'hover') {
      setScrollbarVisible(true);
    }

    const originPointer = axis === 'horizontal' ? event.clientX : event.clientY;
    const originScrollOffset = axis === 'horizontal' ? viewport.scrollLeft : viewport.scrollTop;
    const maxScrollOffset = axis === 'horizontal' ? viewport.scrollWidth - viewport.clientWidth : viewport.scrollHeight - viewport.clientHeight;
    const trackRect = track.getBoundingClientRect();
    const trackSize = axis === 'horizontal' ? trackRect.width : trackRect.height;
    const thumbSize = axis === 'horizontal' ? metrics.horizontalThumbSize : metrics.verticalThumbSize;
    const maxThumbOffset = Math.max(1, trackSize - thumbSize);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const currentPointer = axis === 'horizontal' ? moveEvent.clientX : moveEvent.clientY;
      const delta = currentPointer - originPointer;
      const nextScrollOffset = originScrollOffset + (delta / maxThumbOffset) * maxScrollOffset;

      if (axis === 'horizontal') {
        viewport.scrollLeft = nextScrollOffset;
      } else {
        viewport.scrollTop = nextScrollOffset;
      }
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      draggingScrollbarRef.current = false;
      if (scrollbar === 'hover' && !viewport.matches(':hover')) {
        setScrollbarVisible(false);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const showVerticalScrollbar = orientation !== 'horizontal' && metrics.hasVerticalOverflow;
  const showHorizontalScrollbar = orientation !== 'vertical' && metrics.hasHorizontalOverflow;

  return (
    <div
      {...props}
      className={cn(
        'scroll-area relative min-h-0 overflow-hidden',
        scrollbar === 'hover' && 'scroll-area-scrollbar-hover',
        scrollbarVisible && 'scroll-area-scrollbar-visible',
        className,
      )}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={
        scrollbarSize === undefined
          ? style
          : ({
              ...style,
              '--scroll-area-size': `${scrollbarSize}px`,
            } as CSSProperties)
      }
    >
      <div
        className={cn('scroll-area-viewport h-full w-full min-h-0 min-w-0', viewportOrientationClassName[orientation])}
        onScroll={handleScroll}
        ref={viewportRef}
      >
        {children}
      </div>

      {showVerticalScrollbar ? (
        <div
          className="scroll-area-track scroll-area-track-vertical"
          onPointerDown={handleTrackPointerDown('vertical')}
          ref={verticalTrackRef}
        >
          <div
            className="scroll-area-thumb scroll-area-thumb-vertical"
            onPointerDown={handleThumbPointerDown('vertical')}
            style={{
              height: `${metrics.verticalThumbSize}px`,
              transform: `translateY(${metrics.verticalThumbOffset}px)`,
            }}
          />
        </div>
      ) : null}

      {showHorizontalScrollbar ? (
        <div
          className="scroll-area-track scroll-area-track-horizontal"
          onPointerDown={handleTrackPointerDown('horizontal')}
          ref={horizontalTrackRef}
        >
          <div
            className="scroll-area-thumb scroll-area-thumb-horizontal"
            onPointerDown={handleThumbPointerDown('horizontal')}
            style={{
              transform: `translateX(${metrics.horizontalThumbOffset}px)`,
              width: `${metrics.horizontalThumbSize}px`,
            }}
          />
        </div>
      ) : null}
    </div>
  );
});
