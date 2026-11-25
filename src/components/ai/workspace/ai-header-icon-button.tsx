import type { ComponentProps } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type AiHeaderIconBadgeTone = 'neutral' | 'primary' | 'destructive';

export interface AiHeaderIconButtonProps extends Omit<ComponentProps<typeof Button>, 'variant' | 'size'> {
  readonly badgeCount?: number;
  readonly badgeTone?: AiHeaderIconBadgeTone;
}

/** Shared action sizing for conversation, history, and detail headers. */
export function AiHeaderIconButton({
  badgeCount,
  badgeTone = 'neutral',
  children,
  className,
  ...props
}: AiHeaderIconButtonProps): React.ReactNode {
  const showBadge = typeof badgeCount === 'number' && badgeCount > 0;
  return (
    <Button
      {...props}
      variant="ghost"
      size="icon-xs"
      className={cn('size-7 shrink-0 [&_svg]:size-4', showBadge && 'relative', className)}
    >
      {children}
      {showBadge && (
        <span
          data-slot="ai-header-icon-badge"
          data-tone={badgeTone}
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none tabular-nums ring-1 ring-background',
            badgeTone === 'destructive'
              ? 'bg-destructive text-white'
              : badgeTone === 'primary'
                ? 'bg-primary text-primary-foreground'
                : 'border border-app-border/80 bg-secondary text-secondary-foreground',
          )}
        >
          {badgeCount > 99 ? '99+' : badgeCount}
        </span>
      )}
    </Button>
  );
}
