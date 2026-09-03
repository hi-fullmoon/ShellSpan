import React from 'react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ title, description, icon, action, className }) => {
  return (
    <div data-slot="empty-state" className={cn('flex flex-col items-center justify-center gap-3 p-4 text-muted-foreground', className)}>
      <div data-slot="empty-state-heading" className="flex flex-col items-center gap-3">
        {icon && <div data-slot="empty-state-icon" className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">{icon}</div>}
        <span data-slot="empty-state-title" className="text-sm font-medium text-foreground">{title}</span>
      </div>
      {description && <span data-slot="empty-state-description" className="max-w-sm text-center text-xs leading-5 text-muted-foreground">{description}</span>}
      {action && <div data-slot="empty-state-action">{action}</div>}
    </div>
  );
};

export const PanelEmptyState: React.FC<EmptyStateProps> = (props) => {
  return (
    <div data-slot="panel-empty-state" className="flex min-h-0 flex-1 items-center justify-center">
      <EmptyState {...props} />
    </div>
  );
};

export const Spinner: React.FC<React.ComponentProps<'svg'> & { size?: number }> = ({
  className,
  size = 16,
  ...props
}) => {
  return (
    <svg
      className={cn('animate-spin', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      {...props}
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
};

export interface PanelLoadingStateProps {
  className?: string;
  label?: string;
}

export const PanelLoadingState: React.FC<PanelLoadingStateProps> = ({ className, label }) => {
  return (
    <div className={cn('flex h-full flex-col items-center justify-center gap-3', className)}>
      <Spinner />
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
    </div>
  );
};
