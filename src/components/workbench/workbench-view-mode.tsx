import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  LayoutGridIcon,
  Table2Icon,
} from 'lucide-react';
import { TableHead } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/hooks/useI18n';
import { onLocalStateHydrated, readLocalState, saveLocalState } from '@/lib/preferences/local-state';
import { cn } from '@/lib/utils';

export const WORKBENCH_VIEW_MODES = ['card', 'table'] as const;
export type WorkbenchViewMode = typeof WORKBENCH_VIEW_MODES[number];
export type WorkbenchSortDirection = 'asc' | 'desc';

export interface WorkbenchTableSort<TColumn extends string = string> {
  column: TColumn;
  direction: WorkbenchSortDirection;
}

export const WORKBENCH_VIEW_STORAGE_KEYS = {
  connections: 'shellspan.connections.viewMode',
  portForwards: 'shellspan.workbench.viewMode.portForwards',
  quickActions: 'shellspan.workbench.viewMode.quickActions',
  keychain: 'shellspan.workbench.viewMode.keychain',
  knownHosts: 'shellspan.workbench.viewMode.knownHosts',
} as const;

export function isWorkbenchViewMode(value: unknown): value is WorkbenchViewMode {
  return WORKBENCH_VIEW_MODES.some((mode) => mode === value);
}

export function readWorkbenchViewMode(storageKey: string): WorkbenchViewMode {
  try {
    const saved = readLocalState(storageKey);
    return isWorkbenchViewMode(saved) ? saved : 'card';
  } catch {
    return 'card';
  }
}

export function saveWorkbenchViewMode(storageKey: string, mode: WorkbenchViewMode): void {
  try {
    saveLocalState(storageKey, mode);
  } catch {
    // View switching remains usable when local preference storage is unavailable.
  }
}

export function nextWorkbenchTableSort<TColumn extends string>(
  current: WorkbenchTableSort<TColumn> | null,
  column: TColumn,
): WorkbenchTableSort<TColumn> | null {
  if (!current || current.column !== column) {
    return { column, direction: 'asc' };
  }
  if (current.direction === 'asc') {
    return { column, direction: 'desc' };
  }
  return null;
}

export function useWorkbenchViewMode(
  storageKey: string,
): [WorkbenchViewMode, (mode: WorkbenchViewMode) => void] {
  const [viewMode, setViewMode] = useState<WorkbenchViewMode>(() => readWorkbenchViewMode(storageKey));
  const hasToggledRef = useRef(false);

  useEffect(() => onLocalStateHydrated(() => {
    if (!hasToggledRef.current) {
      setViewMode(readWorkbenchViewMode(storageKey));
    }
  }), [storageKey]);

  const handleChange = useCallback((nextMode: WorkbenchViewMode): void => {
    hasToggledRef.current = true;
    setViewMode(nextMode);
    saveWorkbenchViewMode(storageKey, nextMode);
  }, [storageKey]);

  return [viewMode, handleChange];
}

interface WorkbenchViewModeToggleProps {
  value: WorkbenchViewMode;
  onChange: (mode: WorkbenchViewMode) => void;
  className?: string;
}

export const WorkbenchViewModeToggle: React.FC<WorkbenchViewModeToggleProps> = ({
  value,
  onChange,
  className,
}) => {
  const { t } = useI18n();

  return (
    <ToggleGroup
      aria-label={t('workbench.connections.viewMode')}
      variant="surface"
      spacing={0.5}
      value={[value]}
      onValueChange={(values) => {
        const nextMode = values[0];
        if (isWorkbenchViewMode(nextMode)) {
          onChange(nextMode);
        }
      }}
      className={cn(
        'ml-auto h-6 shrink-0 rounded-md',
        className,
      )}
    >
      {([
        { value: 'card', icon: LayoutGridIcon, label: t('workbench.connections.view.card') },
        { value: 'table', icon: Table2Icon, label: t('workbench.connections.view.table') },
      ] as const).map(({ value: itemValue, icon: Icon, label }) => (
        <Tooltip key={itemValue}>
          <TooltipTrigger
            render={
              <ToggleGroupItem
                value={itemValue}
                aria-label={label}
                className="size-5 min-w-5 rounded-[4px] px-0 [&_svg:not([class*='size-'])]:size-3.5"
              />
            }
          >
            <Icon aria-hidden />
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
};

interface WorkbenchSortableHeadProps<TColumn extends string> {
  column: TColumn;
  label: string;
  sort: WorkbenchTableSort<TColumn> | null;
  onSort: (column: TColumn) => void;
  className?: string;
}

export const WORKBENCH_TABLE_HEADER_CLASS =
  'sticky top-0 z-10 bg-background transition-shadow in-data-[overflow-y-start]:shadow-[0_1px_4px_rgba(0,0,0,0.06)] dark:in-data-[overflow-y-start]:shadow-[0_1px_6px_rgba(0,0,0,0.28)]';

export const WORKBENCH_TABLE_HEADER_ROW_CLASS =
  'border-0 bg-muted/75 hover:bg-muted/75 dark:bg-muted/80 dark:hover:bg-muted/80';

export const WORKBENCH_TABLE_HEAD_CLASS =
  'h-8 border-b border-app-border px-3 text-[11px] font-semibold tracking-[0.02em] text-muted-foreground first:pl-3.5 last:pr-3.5 in-data-[has-overflow-y]:last:pr-4';

export const WORKBENCH_TABLE_ROW_CLASS =
  'group border-0 bg-card transition-colors hover:bg-accent/65 dark:bg-background dark:hover:bg-accent/55';

export const WORKBENCH_TABLE_CELL_CLASS =
  'min-w-0 border-b border-app-border/45 px-3 py-2 align-middle first:pl-3.5 last:pr-3.5 in-data-[has-overflow-y]:last:pr-4';

export const WORKBENCH_TABLE_ACTION_CELL_CLASS =
  'w-[7.25rem] border-b border-app-border/45 px-3 py-1.5 text-right align-middle last:pr-3 in-data-[has-overflow-y]:last:pr-4';

export const WORKBENCH_TABLE_COMPACT_ACTION_CELL_CLASS =
  'w-[5.25rem] border-b border-app-border/45 px-3 py-1.5 text-right align-middle last:pr-3 in-data-[has-overflow-y]:last:pr-4';

export const WORKBENCH_TABLE_ACTION_GROUP_CLASS =
  'flex shrink-0 flex-nowrap items-center justify-end gap-0.5 text-muted-foreground opacity-80 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100';

export const WORKBENCH_TABLE_ICON_BUTTON_CLASS =
  'size-7! rounded-md text-muted-foreground hover:text-foreground [&_svg]:size-3.5';

export const WORKBENCH_TABLE_DESTRUCTIVE_ICON_BUTTON_CLASS =
  'size-7! rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive [&_svg]:size-3.5';

export const WORKBENCH_TABLE_TAG_CLASS =
  'h-[19px] rounded-md px-1.5 text-[11px] font-normal';

export function WorkbenchSortableHead<TColumn extends string>({
  column,
  label,
  sort,
  onSort,
  className,
}: WorkbenchSortableHeadProps<TColumn>) {
  const { t } = useI18n();
  const isActive = sort?.column === column;
  const ariaSort = isActive ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';
  const SortIcon = !isActive
    ? ArrowUpDownIcon
    : sort.direction === 'asc'
      ? ArrowUpIcon
      : ArrowDownIcon;

  return (
    <TableHead aria-sort={ariaSort} className={cn(WORKBENCH_TABLE_HEAD_CLASS, className)}>
      <button
        type="button"
        onClick={() => onSort(column)}
        aria-label={t('workbench.connections.table.sortBy', { column: label })}
        className={cn(
          'group/sort inline-flex items-center gap-1 rounded-sm font-semibold transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none',
          isActive ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        <span>{label}</span>
        <SortIcon
          aria-hidden
          className={cn(
            'size-3 shrink-0 transition-opacity',
            isActive ? 'opacity-90' : 'opacity-0 group-hover/sort:opacity-60 group-focus-visible/sort:opacity-60',
          )}
        />
      </button>
    </TableHead>
  );
}

interface WorkbenchTableFrameProps extends React.ComponentProps<'div'> {
  slot?: string;
}

export const WorkbenchTableFrame: React.FC<WorkbenchTableFrameProps> = ({
  slot = 'workbench-table',
  className,
  ...props
}) => (
  <div
    data-slot={slot}
    className={cn(
      'w-full bg-background [&_table]:border-separate [&_table]:border-spacing-0',
      className,
    )}
    {...props}
  />
);
