import React from 'react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  icon,
  action,
  className,
}) => {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 p-4 text-app-text-soft',
        className,
      )}
    >
      {icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-app-surface-muted text-app-text-soft">
          {icon}
        </div>
      )}
      <span className="text-xs">{title}</span>
      {description && (
        <span className="max-w-xs text-center text-xs text-app-text-soft/80">
          {description}
        </span>
      )}
      {action}
    </div>
  );
};

export const Spinner: React.FC<{ className?: string; size?: number }> = ({
  className,
  size = 16,
}) => {
  return (
    <svg
      className={cn('animate-spin text-app-text-soft', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
};
