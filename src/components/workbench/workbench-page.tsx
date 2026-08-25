import React from 'react';
import { cn } from '@/lib/utils';

export const WORKBENCH_SEARCH_WIDTH_CLASS =
  'flex-1 @min-[42rem]:w-72 @min-[42rem]:flex-none';

type WorkbenchPageProps = React.ComponentProps<'div'>;

export const WorkbenchPage: React.FC<WorkbenchPageProps> = ({ className, ...props }) => (
  <div
    data-slot="workbench-page"
    className={cn(
      '@container flex h-full min-h-0 min-w-0 flex-col bg-background',
      className,
    )}
    {...props}
  />
);

interface WorkbenchPageHeaderProps extends Omit<React.ComponentProps<'header'>, 'title'> {
  icon: React.ElementType;
  title: React.ReactNode;
  description?: React.ReactNode;
  titleMeta?: React.ReactNode;
  actions?: React.ReactNode;
}

export const WorkbenchPageHeader: React.FC<WorkbenchPageHeaderProps> = ({
  icon: Icon,
  title,
  description,
  titleMeta,
  actions,
  children,
  className,
  ...props
}) => (
  <header
    data-slot="workbench-page-header"
    className={cn(
      'flex shrink-0 flex-col gap-3 border-b border-app-border/50 bg-card/80 px-4 py-3',
      className,
    )}
    {...props}
  >
    <div className="flex flex-col gap-3 @min-[42rem]:flex-row @min-[42rem]:items-center @min-[42rem]:justify-between">
      <div className="flex min-w-0 items-center gap-3 @min-[42rem]:shrink-0">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="truncate text-base font-semibold text-foreground">{title}</h1>
            {titleMeta}
          </div>
          {description && (
            <p className="truncate text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 @min-[42rem]:flex-1 @min-[42rem]:justify-end">
          {actions}
        </div>
      )}
    </div>
    {children}
  </header>
);

type WorkbenchPageToolbarProps = React.ComponentProps<'section'>;

export const WorkbenchPageToolbar: React.FC<WorkbenchPageToolbarProps> = ({
  className,
  ...props
}) => (
  <section
    data-slot="workbench-page-toolbar"
    className={cn(
      'flex shrink-0 flex-col gap-2 border-b border-app-border/50 bg-card/40 px-4 py-2.5',
      className,
    )}
    {...props}
  />
);

type WorkbenchPageContentProps = React.ComponentProps<'main'>;

export const WorkbenchPageContent: React.FC<WorkbenchPageContentProps> = ({
  className,
  ...props
}) => (
  <main
    data-slot="workbench-page-content"
    className={cn(
      'mx-auto flex min-h-full w-full max-w-screen-2xl flex-col gap-3 p-3 sm:p-4',
      className,
    )}
    {...props}
  />
);
