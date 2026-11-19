import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Reserve the space of every state while exposing only the active content. */
export function StableContent({ variants, active, className }: {
  readonly variants: readonly ReactNode[];
  readonly active: number;
  readonly className?: string;
}): ReactNode {
  return (
    <span className={cn('grid min-w-0', className)}>
      {variants.map((content, index) => (
        <span key={index} className="col-start-1 row-start-1 min-w-0 aria-hidden:invisible"
          aria-hidden={index !== active || undefined}>
          {content}
        </span>
      ))}
    </span>
  );
}
