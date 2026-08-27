import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FolderIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import type { LocaleKey } from '@/locales';
import {
  normalizePortablePath,
  parsePortablePath,
  parsePosixPath,
  type PathSegment,
} from '@/lib/path-utils';
import {
  calculateVisibleLeadingCount,
  partitionBreadcrumbSegments,
  readBreadcrumbMetrics,
} from './path-breadcrumb-layout';

const SHOW_HIDDEN_SEGMENTS_KEY: LocaleKey = 'sftp.breadcrumb.showHiddenSegments';
const HIDDEN_SEGMENTS_KEY: LocaleKey = 'sftp.breadcrumb.hiddenSegments';

export interface PathBreadcrumbProps {
  path: string;
  onNavigate: (path: string) => void;
  pathKind?: 'local' | 'remote';
  className?: string;
}

function navigateFromButton(
  event: React.MouseEvent<HTMLButtonElement>,
  target: string,
  onNavigate: (path: string) => void,
): void {
  // A double-click emits two click events before the double-click event.
  // Navigate on the first click only and leave double-click-to-edit to the
  // breadcrumb background.
  if (event.detail > 1) return;
  onNavigate(target);
}

const ChevronIcon: React.FC = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3 shrink-0 text-app-text-soft">
    <path d="M9 18l6-6-6-6" />
  </svg>
);

interface BreadcrumbSegmentProps {
  segment: PathSegment;
  onNavigate: (path: string) => void;
}

const BreadcrumbSegment: React.FC<BreadcrumbSegmentProps> = ({ segment, onNavigate }) => (
  <>
    <ChevronIcon />
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => navigateFromButton(event, segment.path, onNavigate)}
            onDoubleClick={(event) => event.stopPropagation()}
            className="h-6 gap-1 px-1 text-muted-foreground hover:text-app-text [&_svg]:size-3"
          />
        }
      >
        <FolderIcon data-icon="inline-start" className="text-app-primary" />
        <span className="max-w-[200px] truncate leading-none">{segment.name}</span>
      </TooltipTrigger>
      <TooltipContent>{segment.name}</TooltipContent>
    </Tooltip>
  </>
);

export const PathBreadcrumb: React.FC<PathBreadcrumbProps> = ({ path, onNavigate, pathKind = 'remote', className }) => {
  const { t } = useI18n();
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(path);
  const [containerWidth, setContainerWidth] = useState(0);
  const [measurementWidth, setMeasurementWidth] = useState(0);
  const [visibleLeadingCount, setVisibleLeadingCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const measurementRef = useRef<HTMLDivElement>(null);

  const parsedPath = useMemo(
    () => (pathKind === 'local' ? parsePortablePath(path) : parsePosixPath(path)),
    [path, pathKind],
  );
  const { rootLabel, rootPath, segments } = parsedPath;
  const isRoot = segments.length === 0;
  const { leadingSegments, hiddenSegments, currentSegment } = useMemo(
    () => partitionBreadcrumbSegments(segments, visibleLeadingCount),
    [segments, visibleLeadingCount],
  );

  useEffect(() => {
    setIsEditing(false);
    setEditValue(path);
  }, [path]);

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
    const nextVisibleCount = calculateVisibleLeadingCount(segments, available, metrics);
    setVisibleLeadingCount((currentCount) => (currentCount === nextVisibleCount ? currentCount : nextVisibleCount));
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
      onNavigate(pathKind === 'local' ? normalizePortablePath(target) : target);
    } else if (e.key === 'Escape') {
      setIsEditing(false);
      setEditValue(path);
    }
  };

  const handleBlur = (): void => {
    setIsEditing(false);
    setEditValue(path);
  };

  return (
    <div
      ref={containerRef}
      className={cn(
        'relative flex h-8 min-w-0 items-center gap-1 overflow-hidden rounded-md border border-app-border bg-app-surface px-2 text-xs',
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
        <Button data-breadcrumb-root tabIndex={-1} variant="ghost" size="sm" className="h-6 gap-1 px-1">
          <span className="truncate max-w-[200px] leading-none">{rootLabel}</span>
        </Button>
        <Button data-breadcrumb-ellipsis tabIndex={-1} variant="ghost" size="sm" disabled className="h-6 px-1">
          <span className="leading-none">...</span>
        </Button>
        {segments.map((segment) => (
          <React.Fragment key={segment.path}>
            <ChevronIcon />
            <Button data-breadcrumb-segment tabIndex={-1} variant="ghost" size="sm" className="h-6 gap-1 px-1 [&_svg]:size-3">
              <FolderIcon data-icon="inline-start" />
              <span className="max-w-[200px] truncate leading-none">{segment.name}</span>
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
          className="h-6 w-full rounded-none border-0 bg-transparent px-0 py-0 text-xs leading-none shadow-none focus-visible:ring-0"
        />
      ) : (
        <>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(event) => navigateFromButton(event, rootPath, onNavigate)}
                  onDoubleClick={(event) => event.stopPropagation()}
                  className="h-6 gap-1 px-1 text-muted-foreground hover:text-app-text"
                />
              }
            >
              <span className="truncate max-w-[200px] leading-none">{rootLabel}</span>
            </TooltipTrigger>
            <TooltipContent>{rootLabel}</TooltipContent>
          </Tooltip>
          {!isRoot && (
            <>
              {!currentSegment ? (
                segments.map((segment) => (
                  <BreadcrumbSegment key={segment.path} segment={segment} onNavigate={onNavigate} />
                ))
              ) : (
                <>
                  {leadingSegments.map((segment) => (
                    <BreadcrumbSegment key={segment.path} segment={segment} onNavigate={onNavigate} />
                  ))}
                  <ChevronIcon />
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t(SHOW_HIDDEN_SEGMENTS_KEY)}
                          onDoubleClick={(event) => event.stopPropagation()}
                          className="h-6 px-1 text-muted-foreground hover:text-app-text"
                        />
                      }
                    >
                      <span className="leading-none">...</span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="bottom" align="start" className="w-auto min-w-40 max-w-80">
                      <DropdownMenuGroup aria-label={t(HIDDEN_SEGMENTS_KEY)}>
                        {hiddenSegments.map((segment) => (
                          <DropdownMenuItem
                            key={segment.path}
                            onClick={() => onNavigate(segment.path)}
                            className="max-w-80"
                          >
                            <FolderIcon data-icon="inline-start" className="text-app-primary" />
                            <span className="truncate">{segment.name}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <BreadcrumbSegment segment={currentSegment} onNavigate={onNavigate} />
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
};
