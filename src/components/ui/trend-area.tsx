import React, { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { buildTrendPath } from '@/lib/trend';

interface TrendAreaProps {
  data: number[];
  /** Tailwind text-color class, e.g. "text-app-primary". Stroke/fill use currentColor. */
  className?: string;
  height?: number;
  fillOpacity?: number;
  min?: number;
  max?: number;
  'aria-label'?: string;
}

/** Lightweight area chart rendered as inline SVG, colored via currentColor. */
export const TrendArea: React.FC<TrendAreaProps> = ({
  data,
  className,
  height = 48,
  fillOpacity = 0.12,
  min,
  max,
  'aria-label': ariaLabel,
}) => {
  const width = 300;
  const { line, area } = useMemo(
    () => buildTrendPath(data, width, height, { min, max }),
    [data, height, min, max],
  );

  if (data.length < 2) {
    return (
      <div
        className={cn(
          'flex h-8 items-center justify-center text-[11px] text-app-text-soft',
          className,
        )}
      >
        ···
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn('block h-auto w-full', className)}
      role="img"
      aria-label={ariaLabel}
    >
      <path d={area} fill="currentColor" opacity={fillOpacity} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};
