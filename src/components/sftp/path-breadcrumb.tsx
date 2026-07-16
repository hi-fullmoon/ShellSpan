import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FolderIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { normalizePortablePath, parsePortablePath, type PortablePathSegment } from '@/lib/path-utils';

export interface PathBreadcrumbProps {
  path: string;
  onNavigate: (path: string) => void;
  normalizeInputPath?: boolean;
  className?: string;
}

const ChevronIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3 w-3 shrink-0 text-app-text-soft">
    <path d="M9 18l6-6-6-6" />
  </svg>
);

export const PathBreadcrumb: React.FC<PathBreadcrumbProps> = ({ path, onNavigate, normalizeInputPath = false, className }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(path);
  const [containerWidth, setContainerWidth] = useState(0);
  const [measurementWidth, setMeasurementWidth] = useState(0);
  const [visibleCount, setVisibleCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const measurementRef = useRef<HTMLDivElement>(null);

  const parsedPath = useMemo(() => parsePortablePath(path), [path]);
  const { rootLabel, rootPath, segments } = parsedPath;
  const isRoot = segments.length === 0;

  useEffect(() => {
    const container = containerRef.current;
    const measurement = measurementRef.current;
    if (!container || !measurement || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      entries.forEach((entry) => {
        const nextWidth = Math.round(entry.contentRect.width);
        if (entry.target === measurement) {
          setMeasurementWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
          return;
        }
        if (entry.target === container || !entry.target) {
          setContainerWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
        }
      });
    });
    observer.observe(container);
    observer.observe(measurement);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const available = containerWidth || Math.max(0, (containerRef.current?.clientWidth ?? 0) - 16);
    const metrics = readBreadcrumbMetrics(measurementRef.current, segments.length);
    const nextVisibleCount = calculateVisibleCount(segments, available, metrics);
    setVisibleCount((currentCount) => (currentCount === nextVisibleCount ? currentCount : nextVisibleCount));
  }, [containerWidth, measurementWidth, segments]);

  const startEditing = (): void => {
    setEditValue(path);
    setIsEditing(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setIsEditing(false);
      const target = editValue.trim();
      onNavigate(normalizeInputPath ? normalizePortablePath(target) : target);
    } else if (e.key === 'Escape') {
      setIsEditing(false);
      setEditValue(path);
    }
  };

  const handleBlur = (): void => {
    setIsEditing(false);
    setEditValue(path);
  };

  const renderSegment = useCallback(
    (segment: (typeof segments)[number]) => (
      <React.Fragment key={segment.path}>
        <ChevronIcon />
        <Tooltip>
          <TooltipTrigger
            delay={0}
            render={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onNavigate(segment.path)}
                className="h-5 gap-1 px-1 text-muted-foreground hover:text-app-text [&_svg]:size-3"
              />
            }
          >
            <FolderIcon className="text-app-primary" />
            <span className="truncate max-w-[200px] leading-none">{segment.name}</span>
          </TooltipTrigger>
          <TooltipContent>{segment.name}</TooltipContent>
        </Tooltip>
      </React.Fragment>
    ),
    [onNavigate],
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex h-7 min-w-0 items-center gap-1 overflow-hidden rounded-md border border-app-border bg-app-surface px-2 text-xs',
        className,
      )}
      onDoubleClick={startEditing}
    >
      <div
        ref={measurementRef}
        data-breadcrumb-measurement
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 flex w-max items-center gap-1"
      >
        <Button data-breadcrumb-root tabIndex={-1} variant="ghost" size="sm" className="h-5 gap-1 px-1">
          <span className="truncate max-w-[200px] leading-none">{rootLabel}</span>
        </Button>
        <Button data-breadcrumb-ellipsis tabIndex={-1} variant="ghost" size="sm" disabled className="h-5 px-1">
          <span className="leading-none">...</span>
        </Button>
        {segments.map((segment) => (
          <React.Fragment key={segment.path}>
            <ChevronIcon />
            <Button data-breadcrumb-segment tabIndex={-1} variant="ghost" size="sm" className="h-5 gap-1 px-1 [&_svg]:size-3">
              <FolderIcon />
              <span className="truncate max-w-[200px] leading-none">{segment.name}</span>
            </Button>
          </React.Fragment>
        ))}
      </div>
      {isEditing ? (
        <Input
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          autoFocus
          onFocus={(e) => e.target.select()}
          className="h-5 w-full rounded-none border-0 bg-transparent px-0 py-0 text-xs leading-none shadow-none focus-visible:ring-0"
        />
      ) : (
        <>
          <Tooltip>
            <TooltipTrigger
              delay={0}
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onNavigate(rootPath)}
                  className="h-5 gap-1 px-1 text-muted-foreground hover:text-app-text"
                />
              }
            >
              <span className="truncate max-w-[200px] leading-none">{rootLabel}</span>
            </TooltipTrigger>
            <TooltipContent>{rootLabel}</TooltipContent>
          </Tooltip>
          {!isRoot && (
            <>
              {visibleCount >= segments.length ? (
                segments.map(renderSegment)
              ) : (
                <>
                  {segments.slice(0, visibleCount).map(renderSegment)}
                  <ChevronIcon />
                  <Button variant="ghost" size="sm" disabled className="h-5 px-1 text-muted-foreground">
                    <span className="leading-none">...</span>
                  </Button>
                  {renderSegment(segments[segments.length - 1])}
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};

const CHEVRON_WIDTH = 12;
const ROOT_WIDTH = 32;
const SEGMENT_CHROME_WIDTH = 32;
const ELLIPSIS_WIDTH = CHEVRON_WIDTH + 32;

interface BreadcrumbMetrics {
  rootWidth: number;
  ellipsisWidth: number;
  chevronWidth: number;
  gap: number;
  segmentWidths: number[];
}

function readBreadcrumbMetrics(measurement: HTMLDivElement | null, segmentCount: number): BreadcrumbMetrics | undefined {
  if (!measurement) return undefined;

  const root = measurement.querySelector<HTMLElement>('[data-breadcrumb-root]');
  const ellipsis = measurement.querySelector<HTMLElement>('[data-breadcrumb-ellipsis]');
  const chevron = measurement.querySelector<SVGElement>('svg');
  const segmentButtons = Array.from(measurement.querySelectorAll<HTMLElement>('[data-breadcrumb-segment]'));
  if (!root || !ellipsis || !chevron || segmentButtons.length !== segmentCount) {
    return undefined;
  }

  const rootWidth = root.getBoundingClientRect().width;
  const ellipsisWidth = ellipsis.getBoundingClientRect().width;
  const chevronWidth = chevron.getBoundingClientRect().width;
  const segmentWidths = segmentButtons.map((button) => button.getBoundingClientRect().width);
  if (rootWidth <= 0 || ellipsisWidth <= 0 || chevronWidth <= 0 || segmentWidths.some((width) => width <= 0)) {
    return undefined;
  }

  const measuredGap = Number.parseFloat(window.getComputedStyle(measurement).columnGap);
  return {
    rootWidth,
    ellipsisWidth,
    chevronWidth,
    gap: Number.isFinite(measuredGap) && measuredGap > 0 ? measuredGap : 4,
    segmentWidths,
  };
}

function calculateVisibleCount(segments: PortablePathSegment[], available: number, metrics?: BreadcrumbMetrics): number {
  if (available <= 0 || segments.length <= 1) {
    return segments.length;
  }

  if (metrics) {
    const fullWidth =
      metrics.rootWidth + metrics.segmentWidths.reduce((total, width) => total + metrics.chevronWidth + width, 0) + metrics.gap * segments.length * 2;
    if (fullWidth <= available) {
      return segments.length;
    }

    const lastWidth = metrics.segmentWidths[metrics.segmentWidths.length - 1];
    let remaining = available - metrics.rootWidth - metrics.ellipsisWidth - lastWidth - metrics.chevronWidth * 2 - metrics.gap * 4;
    let count = 0;
    for (let index = 0; index < metrics.segmentWidths.length - 1; index += 1) {
      const width = metrics.chevronWidth + metrics.segmentWidths[index] + metrics.gap * 2;
      if (remaining < width) break;
      remaining -= width;
      count += 1;
    }
    return count;
  }

  const segmentWidth = (segment: PortablePathSegment): number => CHEVRON_WIDTH + SEGMENT_CHROME_WIDTH + Math.min(200, estimateWidth(segment.name));
  const fullWidth = ROOT_WIDTH + segments.reduce((total, segment) => total + segmentWidth(segment), 0);

  if (fullWidth <= available) {
    return segments.length;
  }

  const lastWidth = segmentWidth(segments[segments.length - 1]);
  let remaining = available - ROOT_WIDTH - ELLIPSIS_WIDTH - lastWidth;
  let count = 0;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const width = segmentWidth(segments[index]);
    if (remaining < width) {
      break;
    }
    remaining -= width;
    count += 1;
  }

  return count;
}

function estimateWidth(text: string): number {
  return text.length * 8 + 24;
}
