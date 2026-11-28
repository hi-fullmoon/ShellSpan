import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface ManagementCardProps extends React.ComponentProps<'div'> {
  selected?: boolean;
}

export const ManagementCard = React.forwardRef<
  HTMLDivElement,
  ManagementCardProps
>(({ className, selected = false, ...props }, ref) => (
  <div
    ref={ref}
    data-slot="management-card"
    className={cn(
      'group flex min-w-0 flex-col gap-1.5 rounded-lg border bg-app-surface p-2.5 transition-all hover:border-app-primary/30 hover:shadow-[var(--shadow-card)]',
      selected
        ? 'border-app-primary ring-1 ring-app-primary/20'
        : 'border-app-border',
      className,
    )}
    {...props}
  />
));

ManagementCard.displayName = 'ManagementCard';

export const ManagementCardIcon: React.FC<React.ComponentProps<'span'>> = ({
  className,
  ...props
}) => (
  <span
    className={cn(
      'flex size-8 shrink-0 items-center justify-center rounded-lg bg-app-primary/10 text-app-primary [&_svg]:size-4',
      className,
    )}
    {...props}
  />
);

export const ManagementCardText: React.FC<{
  text: string;
  className?: string;
}> = ({ text, className }) => {
  const ref = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const updateTruncation = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const nextIsTruncated = element.scrollWidth > element.clientWidth;
    setIsTruncated((current) => (current === nextIsTruncated ? current : nextIsTruncated));
  }, []);

  useLayoutEffect(() => {
    updateTruncation();
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateTruncation);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, updateTruncation]);

  return (
    <Tooltip disabled={!isTruncated}>
      <TooltipTrigger
        render={
          <span
            ref={ref}
            tabIndex={isTruncated ? 0 : undefined}
            className={cn('block min-w-0 truncate', className)}
            onFocus={updateTruncation}
            onMouseEnter={updateTruncation}
          />
        }
      >
        {text}
      </TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-pre-wrap break-words">
        {text}
      </TooltipContent>
    </Tooltip>
  );
};
