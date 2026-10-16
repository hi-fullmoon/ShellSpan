import { useEffect, useRef, useState, type ReactElement } from 'react';
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
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (menuOpen) setOpen(false);
  }, [menuOpen]);
  useEffect(() => {
    if (!controlDisabled && wrapperRef.current === document.activeElement) {
      wrapperRef.current?.querySelector('button')?.focus();
    }
  }, [controlDisabled]);
  if (!enabled) return children;
  return (
    <Tooltip open={open} onOpenChange={setOpen} disabled={menuOpen}>
      <span ref={wrapperRef} tabIndex={controlDisabled ? 0 : undefined}
        className={cn('inline-flex min-w-0', className)}
        onMouseEnter={() => { if (controlDisabled) setOpen(true); }}
        onMouseLeave={() => { if (controlDisabled) setOpen(false); }}
        onFocusCapture={() => { if (controlDisabled) setOpen(true); }}
        onBlurCapture={() => { if (controlDisabled) setOpen(false); }}
        onKeyDown={event => {
          if (controlDisabled && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onClick={event => { if (controlDisabled) event.stopPropagation(); }}>
        <TooltipTrigger render={children} />
      </span>
      <TooltipContent role="tooltip">{label}</TooltipContent>
    </Tooltip>
  );
}
