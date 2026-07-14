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
  const draggingRef = useRef(false);

  const handleMouseDown = useCallback(() => {
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
  }, []);

  const handleMouseUp = useCallback(() => {
    draggingRef.current = false;
    document.body.style.cursor = '';
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
        className="flex w-1 cursor-col-resize items-center justify-center bg-app-border hover:bg-app-primary"
      >
        <div className="h-8 w-0.5 rounded-full bg-app-text-soft/50" />
      </div>
      <div style={{ width: `${(1 - split) * 100}%` }} className="min-w-0">{right}</div>
    </div>
  );
};
