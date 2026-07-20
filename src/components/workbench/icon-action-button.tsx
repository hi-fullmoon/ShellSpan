import React from 'react';
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

export const IconActionButton: React.FC<IconActionButtonProps> = ({
  tooltip,
  children,
  className,
  disabled,
  ...props
}) => {
  const button = (
    <Button
      variant="ghost"
      size="icon"
      className={cn(className)}
      disabled={disabled}
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
