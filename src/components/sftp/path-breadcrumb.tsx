import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FolderIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface PathBreadcrumbProps {
  path: string;
  onNavigate: (path: string) => void;
  className?: string;
}

const ChevronIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="h-3 w-3 shrink-0 text-app-text-soft"
  >
    <path d="M9 18l6-6-6-6" />
  </svg>
);

interface Segment {
  name: string;
  path: string;
  index: number;
}

export const PathBreadcrumb: React.FC<PathBreadcrumbProps> = ({
  path,
  onNavigate,
  className,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(path);
  const [containerWidth, setContainerWidth] = useState(0);
  const [visibleCount, setVisibleCount] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const normalized = path.replace(/\\/g, '/');
  const isRoot = normalized === '' || normalized === '/';
  const segments: Segment[] = useMemo(() => {
    if (isRoot) return [];
    const parts = normalized.split('/').filter(Boolean);
    return parts.map((part, index) => ({
      name: part,
      path: '/' + parts.slice(0, index + 1).join('/'),
      index,
    }));
  }, [isRoot, normalized]);

  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const total = containerRef.current.scrollWidth;
    const available = containerRef.current.clientWidth;
    if (total <= available || segments.length <= 1) {
      setVisibleCount(segments.length);
    } else {
      const chevron = 12;
      const rootWidth = 32;
      const lastWidth = chevron + 32 + Math.min(200, estimateWidth(segments[segments.length - 1].name));
      const ellipsisWidth = chevron + 32;
      const minimumWidth = rootWidth + ellipsisWidth + lastWidth;
      let remaining = available - minimumWidth;
      let count = 0;
      for (let i = 0; i < segments.length - 1; i++) {
        const width = chevron + 32 + Math.min(200, estimateWidth(segments[i].name));
        if (remaining >= width) {
          remaining -= width;
          count++;
        } else {
          break;
        }
      }
      setVisibleCount(count);
    }
  }, [containerWidth, segments]);

  const startEditing = (): void => {
    setEditValue(path);
    setIsEditing(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setIsEditing(false);
      onNavigate(editValue.trim());
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
    (segment: Segment) => (
      <React.Fragment key={segment.index}>
        <ChevronIcon />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onNavigate(segment.path)}
          className="h-5 gap-1 px-1 text-muted-foreground hover:text-app-text [&_svg]:size-3"
          title={segment.name}
        >
          <FolderIcon className="text-app-primary" />
          <span className="truncate max-w-[200px] leading-none">{segment.name}</span>
        </Button>
      </React.Fragment>
    ),
    [onNavigate],
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex h-7 items-center gap-1 overflow-hidden rounded-md border border-app-border bg-app-surface px-2 text-xs',
        className,
      )}
      onDoubleClick={startEditing}
    >
      {isEditing ? (
        <Input
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          autoFocus
          onFocus={(e) => e.target.select()}
          className="h-5 w-full rounded-none border-0 bg-transparent px-0 py-0 text-xs shadow-none focus-visible:ring-0"
        />
      ) : (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onNavigate('/')}
            className="h-5 gap-1 px-1 text-muted-foreground hover:text-app-text"
            title="/"
          >
            <span className="truncate max-w-[200px] leading-none">/</span>
          </Button>
          {!isRoot && (
            <>
              {visibleCount >= segments.length ? (
                segments.map(renderSegment)
              ) : (
                <>
                  {segments.slice(0, visibleCount).map(renderSegment)}
                  <ChevronIcon />
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled
                    className="h-5 px-1 text-muted-foreground"
                  >
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

function estimateWidth(text: string): number {
  return text.length * 8 + 24;
}
