import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../lib/ui';

type ScrollAreaOrientation = 'vertical' | 'horizontal' | 'both';

interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: ScrollAreaOrientation;
  scrollbar?: 'default' | 'hover';
  scrollbarSize?: number;
}

const viewportOrientationClassName: Record<ScrollAreaOrientation, string> = {
  vertical: 'overflow-x-hidden overflow-y-auto',
  horizontal: 'overflow-x-auto overflow-y-hidden',
  both: 'overflow-auto',
};

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { children, className, onScroll, orientation = 'vertical', scrollbar, scrollbarSize, style, ...props },
  ref,
) {
  return (
    <div
      {...props}
      className={cn('relative min-h-0 overflow-hidden', className)}
      style={style}
    >
      <div
        className={cn('h-full w-full min-h-0 min-w-0', viewportOrientationClassName[orientation])}
        onScroll={onScroll}
        ref={ref as React.Ref<HTMLDivElement>}
      >
        {children}
      </div>
    </div>
  );
});
