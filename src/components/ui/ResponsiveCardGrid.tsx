import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface ResponsiveGridBreakpoint {
  /** The container width, in pixels, at which this column count takes effect. */
  minWidth: number;
  columns: number;
}

export interface ResponsiveCardGridProps {
  children: React.ReactNode;
  className?: string;
  gridClassName?: string;
  /** Column count below the first breakpoint. */
  columns?: number;
  /** Container-width breakpoints. Order does not matter. */
  breakpoints?: readonly ResponsiveGridBreakpoint[];
  gap?: number | string;
}

const DEFAULT_BREAKPOINTS: readonly ResponsiveGridBreakpoint[] = [
  { minWidth: 900, columns: 4 },
  { minWidth: 1200, columns: 5 },
];

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

export const ResponsiveCardGrid: React.FC<ResponsiveCardGridProps> = ({
  children,
  className,
  gridClassName,
  columns = 3,
  breakpoints = DEFAULT_BREAKPOINTS,
  gap = '0.5rem',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    let frameId = 0;
    const updateWidth = (width: number) => setContainerWidth(width);
    const measure = (): void => {
      updateWidth(element.getBoundingClientRect().width);
    };

    measure();
    frameId = window.requestAnimationFrame(measure);

    const handleWindowResize = (): void => {
      measure();
    };

    window.addEventListener('resize', handleWindowResize);

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        window.cancelAnimationFrame(frameId);
        window.removeEventListener('resize', handleWindowResize);
      };
    }

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      updateWidth(entry.contentRect.width);
    });

    observer.observe(element);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', handleWindowResize);
      observer.disconnect();
    };
  }, []);

  const currentColumns = useMemo(() => {
    let result = positiveInteger(columns, 'columns');

    for (const { minWidth, columns: breakpointColumns } of [...breakpoints].sort(
      (a, b) => a.minWidth - b.minWidth,
    )) {
      if (!Number.isFinite(minWidth) || minWidth < 0) {
        throw new Error('breakpoint minWidth must be a non-negative number');
      }
      const validColumns = positiveInteger(
        breakpointColumns,
        'breakpoint columns',
      );
      if (containerWidth >= minWidth) result = validColumns;
    }

    return result;
  }, [breakpoints, columns, containerWidth]);

  return (
    <div ref={containerRef} className={cn('w-full', className)}>
      <div
        className={cn('grid', gridClassName)}
        style={{
          gap,
          gridTemplateColumns: `repeat(${currentColumns}, minmax(0, 1fr))`,
        }}
      >
        {children}
      </div>
    </div>
  );
};
