import React from 'react';
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
    className={cn(
      'group flex min-w-0 flex-col gap-2.5 rounded-lg border bg-app-surface p-3 transition-all hover:border-app-primary/30 hover:shadow-[var(--shadow-card)]',
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
      'flex size-9 shrink-0 items-center justify-center rounded-lg bg-app-primary/10 text-app-primary [&_svg]:size-4',
      className,
    )}
    {...props}
  />
);
