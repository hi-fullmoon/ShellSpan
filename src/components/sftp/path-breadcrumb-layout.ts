import type { PathSegment } from '@/lib/path-utils';

const CHEVRON_WIDTH = 12;
const ROOT_WIDTH = 32;
const SEGMENT_CHROME_WIDTH = 32;
const ELLIPSIS_WIDTH = CHEVRON_WIDTH + 32;

export interface BreadcrumbMetrics {
  rootWidth: number;
  ellipsisWidth: number;
  chevronWidth: number;
  gap: number;
  segmentWidths: number[];
}

export interface PartitionedBreadcrumbSegments {
  leadingSegments: PathSegment[];
  hiddenSegments: PathSegment[];
  currentSegment?: PathSegment;
}

export function partitionBreadcrumbSegments(
  segments: PathSegment[],
  visibleLeadingCount: number,
): PartitionedBreadcrumbSegments {
  if (visibleLeadingCount >= segments.length) {
    return {
      leadingSegments: segments,
      hiddenSegments: [],
    };
  }

  return {
    leadingSegments: segments.slice(0, visibleLeadingCount),
    hiddenSegments: segments.slice(visibleLeadingCount, -1),
    currentSegment: segments[segments.length - 1],
  };
}

export function readBreadcrumbMetrics(
  measurement: HTMLDivElement | null,
  segmentCount: number,
): BreadcrumbMetrics | undefined {
  if (!measurement) return undefined;

  const root = measurement.querySelector<HTMLElement>('[data-breadcrumb-root]');
  const ellipsis = measurement.querySelector<HTMLElement>('[data-breadcrumb-ellipsis]');
  const chevron = measurement.querySelector<SVGElement>('svg');
  const segmentButtons = Array.from(
    measurement.querySelectorAll<HTMLElement>('[data-breadcrumb-segment]'),
  );
  if (!root || !ellipsis || !chevron || segmentButtons.length !== segmentCount) {
    return undefined;
  }

  const rootWidth = root.getBoundingClientRect().width;
  const ellipsisWidth = ellipsis.getBoundingClientRect().width;
  const chevronWidth = chevron.getBoundingClientRect().width;
  const segmentWidths = segmentButtons.map((button) => button.getBoundingClientRect().width);
  if (
    rootWidth <= 0
    || ellipsisWidth <= 0
    || chevronWidth <= 0
    || segmentWidths.some((width) => width <= 0)
  ) {
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

export function calculateVisibleLeadingCount(
  segments: PathSegment[],
  available: number,
  metrics?: BreadcrumbMetrics,
): number {
  if (available <= 0 || segments.length <= 1) {
    return segments.length;
  }

  if (metrics) {
    const fullWidth = metrics.rootWidth
      + metrics.segmentWidths.reduce(
        (total, width) => total + metrics.chevronWidth + width,
        0,
      )
      + metrics.gap * segments.length * 2;
    if (fullWidth <= available) {
      return segments.length;
    }

    const lastWidth = metrics.segmentWidths[metrics.segmentWidths.length - 1];
    let remaining = available
      - metrics.rootWidth
      - metrics.ellipsisWidth
      - lastWidth
      - metrics.chevronWidth * 2
      - metrics.gap * 4;
    let count = 0;
    for (let index = 0; index < metrics.segmentWidths.length - 1; index += 1) {
      const width = metrics.chevronWidth + metrics.segmentWidths[index] + metrics.gap * 2;
      if (remaining < width) break;
      remaining -= width;
      count += 1;
    }
    return count;
  }

  const segmentWidth = (segment: PathSegment): number => (
    CHEVRON_WIDTH
    + SEGMENT_CHROME_WIDTH
    + Math.min(200, estimateWidth(segment.name))
  );
  const fullWidth = ROOT_WIDTH
    + segments.reduce((total, segment) => total + segmentWidth(segment), 0);

  if (fullWidth <= available) {
    return segments.length;
  }

  const lastWidth = segmentWidth(segments[segments.length - 1]);
  let remaining = available - ROOT_WIDTH - ELLIPSIS_WIDTH - lastWidth;
  let count = 0;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const width = segmentWidth(segments[index]);
    if (remaining < width) break;
    remaining -= width;
    count += 1;
  }

  return count;
}

function estimateWidth(text: string): number {
  return text.length * 8 + 24;
}
