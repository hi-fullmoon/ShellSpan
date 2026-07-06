import React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          'h-8 w-full rounded-lg border border-app-border bg-app-surface px-3 text-xs text-app-text shadow-sm transition-colors placeholder:text-app-text-soft focus:border-app-primary focus:outline-none focus:ring-2 focus:ring-app-primary/20',
          className,
        )}
        {...props}
      />
    );
  },
);

Input.displayName = 'Input';
