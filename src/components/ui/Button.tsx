import React from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'icon';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'secondary',
      size = 'md',
      children,
      ...props
    },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-app-primary/50 disabled:opacity-50 disabled:pointer-events-none active:scale-[0.98]',
          variant === 'primary' &&
            'bg-app-primary text-app-primary-text shadow-sm hover:bg-app-primary/90',
          variant === 'secondary' &&
            'bg-app-surface-muted text-app-text hover:bg-app-border',
          variant === 'ghost' &&
            'bg-transparent text-app-text hover:bg-app-surface-muted',
          variant === 'danger' &&
            'bg-app-error text-white shadow-sm hover:bg-app-error/90',
          size === 'sm' && 'h-7 px-2.5 text-xs',
          size === 'md' && 'h-8 px-3.5 text-xs',
          size === 'icon' && 'h-7 w-7',
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);

Button.displayName = 'Button';
