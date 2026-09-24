import React from 'react';
import { cn } from '@/lib/utils';

export interface DeploymentPaneHeaderProps extends React.ComponentProps<'header'> {
  title: string;
  description?: string;
  titleMeta?: React.ReactNode;
  actions?: React.ReactNode;
}

// Column headers of the deployment workbench panes share one height structure
// so the pane borders below them stay aligned across resizable columns.
export const DeploymentPaneHeader: React.FC<DeploymentPaneHeaderProps> = ({ title, description, titleMeta, actions, className, ...props }) => (
  <header
    data-slot="deployment-pane-header"
    className={cn('flex min-h-12 shrink-0 flex-nowrap items-center justify-between gap-2 overflow-hidden border-b px-2 py-1.5', className)}
    {...props}
  >
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        {titleMeta}
      </div>
      {description !== undefined && <p className="truncate text-xs text-muted-foreground">{description}</p>}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
  </header>
);
