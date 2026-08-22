import * as React from 'react';
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area';

import { cn } from '@/lib/utils';

type ScrollbarSize = 'default' | 'thin';

interface ScrollAreaProps extends ScrollAreaPrimitive.Root.Props {
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportRender?: ScrollAreaPrimitive.Viewport.Props['render'];
  horizontal?: boolean;
  vertical?: boolean;
  size?: ScrollbarSize;
  onWheel?: React.WheelEventHandler<HTMLDivElement>;
}

function ScrollArea({
  className,
  children,
  viewportRef,
  viewportRender,
  horizontal = false,
  vertical = true,
  size = 'default',
  onWheel,
  ...props
}: ScrollAreaProps) {
  return (
    <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn('group/scroll-area relative min-h-0', className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        render={viewportRender}
        data-slot="scroll-area-viewport"
        onWheel={onWheel}
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {vertical && <ScrollBar size={size} />}
      {horizontal && <ScrollBar orientation="horizontal" size={size} />}
      <ScrollAreaPrimitive.Corner className="bg-transparent" />
    </ScrollAreaPrimitive.Root>
  );
}

interface ScrollBarProps extends ScrollAreaPrimitive.Scrollbar.Props {
  size?: ScrollbarSize;
}

function ScrollBar({ className, orientation = 'vertical', size = 'default', ...props }: ScrollBarProps) {
  const isHorizontal = orientation === 'horizontal';
  const isThin = size === 'thin';

  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        'flex touch-none select-none',
        isHorizontal ? cn('w-full flex-row', isThin ? 'h-1' : 'h-2') : cn('h-full flex-col', isThin ? 'w-1' : 'w-2'),
        isThin ? 'bg-transparent' : 'transition-colors',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="scroll-area-thumb"
        className={cn(
          'relative transition-colors',
          isThin ? 'bg-transparent group-hover/scroll-area:bg-app-text-soft/35 hover:bg-app-text-soft/50' : 'bg-app-border hover:bg-app-text-soft/60',
        )}
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

export { ScrollArea, ScrollBar };
