import React, { useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface IconActionButtonProps extends React.ComponentProps<typeof Button> {
  tooltip: React.ReactNode;
}

/**
 * Icon button wrapped in a tooltip.
 *
 * Uses a ref-based guard to prevent double-firing when the click event
 * is processed by both the inner Button and the wrapping TooltipTrigger.
 */
export const IconActionButton: React.FC<IconActionButtonProps> = ({
  tooltip,
  children,
  className,
  disabled,
  onClick,
  ...props
}) => {
  const clickGuardRef = useRef(false);
  const guardResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (guardResetTimerRef.current !== null) {
        clearTimeout(guardResetTimerRef.current);
      }
    };
  }, []);

  const handleClick = useCallback(
    (e: Parameters<NonNullable<typeof onClick>>[0]) => {
      if (clickGuardRef.current) return;
      clickGuardRef.current = true;
      onClick?.(e);
      guardResetTimerRef.current = setTimeout(() => {
        clickGuardRef.current = false;
      }, 0);
    },
    [onClick],
  );

  const button = (
    <Button
      variant="ghost"
      size="icon"
      className={cn(className)}
      disabled={disabled}
      onClick={handleClick}
      {...props}
    >
      {children}
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex"
            aria-label={disabled ? props['aria-label'] : undefined}
            aria-disabled={disabled || undefined}
            tabIndex={disabled ? 0 : -1}
          />
        }
      >
        {button}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
};
