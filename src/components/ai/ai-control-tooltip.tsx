import { useEffect, useRef, type ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Keep the current value readable even when a compact control is disabled. */
export function AiControlTooltip({ children, label, controlDisabled = false, menuOpen = false, enabled = true, className }: {
  readonly children: ReactElement;
  readonly label: string;
  readonly controlDisabled?: boolean;
  readonly menuOpen?: boolean;
  readonly enabled?: boolean;
  readonly className?: string;
}): React.ReactNode {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!controlDisabled && wrapperRef.current === document.activeElement) {
      wrapperRef.current?.querySelector('button')?.focus();
    }
  }, [controlDisabled]);
  if (!enabled) return children;
  return (
    <Tooltip disabled={menuOpen}>
      <TooltipTrigger render={
        <span
          ref={wrapperRef}
          tabIndex={controlDisabled ? 0 : undefined}
          className={cn('inline-flex min-w-0', className)}
          onKeyDown={event => {
            if (controlDisabled && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onClick={event => { if (controlDisabled) event.stopPropagation(); }}
        />
      }>
        {children}
      </TooltipTrigger>
      <TooltipContent role="tooltip">{label}</TooltipContent>
    </Tooltip>
  );
}
