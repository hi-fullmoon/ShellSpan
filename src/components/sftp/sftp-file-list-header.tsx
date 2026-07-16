import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';

export type SftpFileListSortColumn = 'name' | 'modifiedAt' | 'size' | 'kind';
export type SftpFileListSortDirection = 'asc' | 'desc' | 'default';

export interface SftpFileListHeaderProps {
  side: 'local' | 'remote';
  sortColumn: SftpFileListSortColumn;
  sortDirection: SftpFileListSortDirection;
  onSort: (column: SftpFileListSortColumn) => void;
}

interface HeaderColumn {
  key: SftpFileListSortColumn | 'owner' | 'group';
  label: string;
  width: string;
  sortable?: SftpFileListSortColumn;
}

const SortIcon: React.FC<{ direction: SftpFileListSortDirection }> = ({
  direction,
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className={cn(
      'h-3 w-3 shrink-0 opacity-60',
      direction === 'desc' && 'rotate-180',
    )}
  >
    <path d="M18 15l-6-6-6 6" />
  </svg>
);

export const SftpFileListHeader: React.FC<SftpFileListHeaderProps> = ({
  side,
  sortColumn,
  sortDirection,
  onSort,
}) => {
  const { t } = useI18n();

  const columns: HeaderColumn[] = [
    {
      key: 'name',
      label: t('sftp.columns.name'),
      width: 'minmax(120px, 1fr)',
      sortable: 'name',
    },
    {
      key: 'modifiedAt',
      label: t('sftp.columns.dateModified'),
      width: '148px',
      sortable: 'modifiedAt',
    },
    { key: 'size', label: t('sftp.columns.size'), width: '88px', sortable: 'size' },
    { key: 'kind', label: t('sftp.columns.type'), width: '96px', sortable: 'kind' },
  ];

  if (side === 'remote') {
    columns.push(
      { key: 'owner', label: t('sftp.columns.owner'), width: '88px' },
      { key: 'group', label: t('sftp.columns.group'), width: '88px' },
    );
  }

  const gridTemplateColumns = columns.map((c) => c.width).join(' ');

  return (
    <div
      className="grid h-8 shrink-0 items-center border-b border-app-border bg-app-surface-muted px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
      style={{ gridTemplateColumns }}
    >
      {columns.map((column) => {
        const isSorted = column.sortable === sortColumn;
        return (
          <button
            key={column.key}
            onClick={() => column.sortable && onSort(column.sortable)}
            disabled={!column.sortable}
            className={cn(
              'flex h-full items-center gap-1 truncate pr-2 text-left',
              column.sortable
                ? 'cursor-pointer hover:text-app-text'
                : 'cursor-default',
            )}
          >
            <span className="truncate">{column.label}</span>
            {isSorted && <SortIcon direction={sortDirection} />}
          </button>
        );
      })}
    </div>
  );
};
