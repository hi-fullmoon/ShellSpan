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
    <div className={cn('flex flex-col items-center justify-center gap-4 p-4 text-muted-foreground', className)}>
      {icon && <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">{icon}</div>}
      <span className="text-xs">{title}</span>
      {description && <span className="text-center text-xs text-muted-foreground/80">{description}</span>}
      {action}
    </div>
  );
};

export const PanelEmptyState: React.FC<EmptyStateProps> = (props) => {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState {...props} />
    </div>
  );
};

export const Spinner: React.FC<{ className?: string; size?: number }> = ({ className, size = 16 }) => {
  return (
    <svg className={cn('animate-spin text-muted-foreground', className)} width={size} height={size} viewBox="0 0 24 24" fill="none">
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
