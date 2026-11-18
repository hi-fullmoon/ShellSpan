import React from 'react';
import { SearchIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';

type WorkbenchSearchClearProps =
  | { onClear?: never; clearLabel?: never }
  | { onClear: () => void; clearLabel: string };

type WorkbenchSearchInputProps = React.ComponentProps<typeof InputGroupInput> &
  WorkbenchSearchClearProps;

export const WorkbenchSearchInput: React.FC<WorkbenchSearchInputProps> = ({
  className,
  onClear,
  clearLabel,
  value,
  ...props
}) => (
  <InputGroup
    variant="transparent"
    className={cn(
      'h-8 w-64 max-w-full flex-none has-[[data-slot=input-group-control]:focus-visible]:border-input has-[[data-slot=input-group-control]:focus-visible]:ring-1 has-[[data-slot=input-group-control]:focus-visible]:ring-ring',
      'in-data-[slot=workbench-page-header-actions]:w-32 in-data-[slot=workbench-page-header-actions]:max-w-64 in-data-[slot=workbench-page-header-actions]:flex-1',
    )}
  >
    <InputGroupInput className={className} value={value} {...props} />
    <InputGroupAddon align="inline-start">
      <SearchIcon aria-hidden />
    </InputGroupAddon>
    {onClear && Boolean(value) && (
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          onClick={onClear}
          aria-label={clearLabel}
        >
          <XIcon />
        </InputGroupButton>
      </InputGroupAddon>
    )}
  </InputGroup>
);

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
      'flex shrink-0 flex-col gap-2 border-b border-app-border/50 bg-card/80 px-2.5 py-1.5',
      className,
    )}
    {...props}
  >
    <div className="flex flex-wrap items-center gap-2">
      <div
        data-slot="workbench-page-header-copy"
        className="flex h-9 max-w-full min-w-0 shrink-0 items-center gap-2"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="flex h-5 min-w-0 items-center gap-2 [&>[data-slot=popover-trigger]]:size-5">
            <h1 className="truncate text-sm font-semibold text-foreground">{title}</h1>
            {titleMeta}
          </div>
          {description && (
            <p className="truncate text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      {actions && (
        <div
          data-slot="workbench-page-header-actions"
          className={cn(
            '-m-1 flex h-10 min-w-0 flex-nowrap items-center gap-2 overflow-x-auto overflow-y-hidden p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>button]:shrink-0',
            // Reserve enough room for the controls before wrapping, then fill the available row.
            'flex-[1_1_min-content] justify-end-safe',
          )}
        >
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
      'flex shrink-0 flex-col gap-2 border-b border-app-border/50 bg-card/40 px-2.5 py-1',
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
      'mx-auto flex min-h-full w-full flex-col gap-3 p-2.5',
      className,
    )}
    {...props}
  />
);
