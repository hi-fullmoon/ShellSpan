import type { ComponentProps } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Shared action sizing for conversation, history, and detail headers. */
export function AiHeaderIconButton({
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'variant' | 'size'>): React.ReactNode {
  return (
    <Button
      {...props}
      variant="ghost"
      size="icon-xs"
      className={cn('size-7 shrink-0 [&_svg]:size-4', className)}
    />
  );
}
