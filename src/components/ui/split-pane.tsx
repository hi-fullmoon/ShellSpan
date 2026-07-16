import React, { useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  minWidth?: number;
  defaultSplit?: number;
  className?: string;
}

export const SplitPane: React.FC<SplitPaneProps> = ({
  left,
  right,
  minWidth = 240,
  defaultSplit = 0.5,
  className,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(defaultSplit);
  const [dragging, setDragging] = useState(false);
  const [suppressGroup, setSuppressGroup] = useState(false);
  const draggingRef = useRef(false);

  const handleMouseDown = useCallback(() => {
    draggingRef.current = true;
    setDragging(true);
    document.body.style.cursor = 'col-resize';
  }, []);

  const handleMouseUp = useCallback(() => {
    draggingRef.current = false;
    setDragging(false);
    setSuppressGroup(true);
    document.body.style.cursor = '';
  }, []);

  const handleMouseEnter = useCallback(() => {
    setSuppressGroup(false);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const width = rect.width;
      const x = e.clientX - rect.left;
      const nextSplit = Math.min(
        Math.max(x / width, minWidth / width),
        1 - minWidth / width,
      );
      setSplit(nextSplit);
    },
    [minWidth],
  );

  React.useEffect(() => {
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousemove', handleMouseMove);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousemove', handleMouseMove);
    };
  }, [handleMouseUp, handleMouseMove]);

  return (
    <div
      ref={containerRef}
      className={cn('flex h-full w-full overflow-hidden', className)}
    >
      <div style={{ width: `${split * 100}%` }} className="min-w-0">{left}</div>
      <div
        onMouseDown={handleMouseDown}
        onMouseEnter={handleMouseEnter}
        className={cn(
          'relative z-10 flex w-px shrink-0 cursor-col-resize items-center justify-center bg-transparent',
          !suppressGroup && 'group',
        )}
      >
        <div
          className={cn(
            'absolute left-1/2 top-0 h-full -translate-x-1/2 transition-all duration-150',
            dragging
              ? 'w-[3px] bg-app-primary'
              : 'w-px bg-app-border delay-0 group-hover:w-[3px] group-hover:bg-app-primary group-hover:delay-200',
          )}
        />
      </div>
      <div style={{ width: `${(1 - split) * 100}%` }} className="min-w-0">{right}</div>
    </div>
  );
};
