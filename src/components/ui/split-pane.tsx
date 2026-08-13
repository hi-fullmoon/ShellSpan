import React, { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  minWidth?: number;
  direction?: 'horizontal' | 'vertical';
  defaultSplit?: number;
  split?: number;
  onSplitChange?: (split: number) => void;
  className?: string;
  dividerStyle?: 'default' | 'subtle';
}

export const SplitPane: React.FC<SplitPaneProps> = ({
  left,
  right,
  minWidth = 240,
  direction = 'horizontal',
  defaultSplit = 0.5,
  split: controlledSplit,
  onSplitChange,
  className,
  dividerStyle = 'default',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [internalSplit, setInternalSplit] = useState(defaultSplit);
  const split = controlledSplit ?? internalSplit;
  const [dragging, setDragging] = useState(false);
  const [suppressGroup, setSuppressGroup] = useState(false);
  const draggingRef = useRef(false);

  const setSplit = useCallback(
    (next: number) => {
      if (onSplitChange) {
        onSplitChange(next);
      } else {
        setInternalSplit(next);
      }
    },
    [onSplitChange],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Prevent the browser from starting a text selection when the drag
      // carries the pointer over pane content.
      e.preventDefault();
      draggingRef.current = true;
      setDragging(true);
      document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [direction],
  );

  const handleMouseUp = useCallback(() => {
    draggingRef.current = false;
    setDragging(false);
    setSuppressGroup(true);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const handleMouseEnter = useCallback(() => {
    setSuppressGroup(false);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const size = direction === 'horizontal' ? rect.width : rect.height;
      const position = direction === 'horizontal' ? e.clientX - rect.left : e.clientY - rect.top;
      const nextSplit = Math.min(Math.max(position / size, minWidth / size), 1 - minWidth / size);
      setSplit(nextSplit);
    },
    [direction, minWidth, setSplit],
  );

  React.useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousemove', handleMouseMove);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousemove', handleMouseMove);
      // Restore global styles if the component unmounts mid-drag.
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [handleMouseUp, handleMouseMove]);

  return (
    <div
      ref={containerRef}
      data-direction={direction}
      className={cn('flex h-full w-full overflow-hidden', direction === 'vertical' && 'flex-col', className)}
    >
      <div style={direction === 'horizontal' ? { width: `${split * 100}%` } : { height: `${split * 100}%` }} className="min-h-0 min-w-0">
        {left}
      </div>
      <div
        data-slot="split-pane-divider"
        className={cn(
          'relative z-10 shrink-0 shadow-none scale-[-1]',
          direction === 'horizontal'
            ? dividerStyle === 'subtle'
              ? 'border-l-[0.5px] border-app-border/15 dark:border-l dark:border-app-border'
              : 'border-l border-app-border'
            : dividerStyle === 'subtle'
              ? 'border-t-[0.5px] border-app-border/15 dark:border-t dark:border-app-border'
              : 'border-t border-app-border',
        )}
      >
        <div
          data-slot="split-pane-handle"
          onMouseDown={handleMouseDown}
          onMouseEnter={handleMouseEnter}
          className={cn(
            'absolute flex items-center justify-center bg-transparent shadow-none',
            direction === 'horizontal'
              ? 'left-1/2 top-0 h-full w-[3px] -translate-x-1/2 cursor-col-resize'
              : 'left-0 top-1/2 h-[3px] w-full -translate-y-1/2 cursor-row-resize',
            !suppressGroup && 'group',
          )}
        >
          <div
            data-slot="split-pane-indicator"
            className={cn(
              'transition-all duration-150 shadow-none',
              direction === 'horizontal' ? 'h-full' : 'w-full',
              dragging
                ? direction === 'horizontal'
                  ? dividerStyle === 'subtle'
                    ? 'w-0.5 bg-app-primary/80'
                    : 'w-[3px] bg-app-primary'
                  : dividerStyle === 'subtle'
                    ? 'h-0.5 bg-app-primary/80'
                    : 'h-[3px] bg-app-primary'
                : direction === 'horizontal'
                  ? dividerStyle === 'subtle'
                    ? 'w-px bg-transparent delay-0 group-hover:w-0.5 group-hover:bg-app-primary/80 group-hover:delay-200'
                    : 'w-px bg-transparent delay-0 group-hover:w-[3px] group-hover:bg-app-primary group-hover:delay-200'
                  : dividerStyle === 'subtle'
                    ? 'h-px bg-transparent delay-0 group-hover:h-0.5 group-hover:bg-app-primary/80 group-hover:delay-200'
                    : 'h-px bg-transparent delay-0 group-hover:h-[3px] group-hover:bg-app-primary group-hover:delay-200',
            )}
          />
        </div>
      </div>
      <div style={direction === 'horizontal' ? { width: `${(1 - split) * 100}%` } : { height: `${(1 - split) * 100}%` }} className="min-h-0 min-w-0">
        {right}
      </div>
    </div>
  );
};
