import React, { useMemo, useRef } from 'react';
import {
  AllCommunityModule,
  ModuleRegistry,
  type CellContextMenuEvent,
  type ColDef,
  type ICellRendererParams,
  type RowClickedEvent,
  type RowDoubleClickedEvent,
  type SelectionChangedEvent,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { cn, formatBytes, formatDate } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import type { LocalFileEntry, RemoteFileEntry, RemoteFileKind } from '@/types';

ModuleRegistry.registerModules([AllCommunityModule]);

export type FileEntry = LocalFileEntry | RemoteFileEntry;

export interface SftpFileGridProps {
  entries: FileEntry[];
  side: 'local' | 'remote';
  selectedPaths: string[];
  filterQuery: string;
  batchMode: boolean;
  onSelect: (paths: string[]) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onContextMenu: (entry: FileEntry, e: React.MouseEvent) => void;
}

function isRemoteEntry(entry: FileEntry): entry is RemoteFileEntry {
  return 'ownerUid' in entry || 'groupGid' in entry;
}

function permissionTypePrefix(kind: RemoteFileKind): string {
  switch (kind) {
    case 'directory':
      return 'd';
    case 'symlink':
      return 'l';
    case 'file':
      return '-';
    case 'other':
    default:
      return '?';
  }
}

function formatPermissionSymbolic(
  permissions: number | undefined,
  kind: RemoteFileKind,
): string {
  if (permissions === undefined) {
    return '--';
  }

  const ownerExec = (permissions & 0o100) === 0o100;
  const groupExec = (permissions & 0o010) === 0o010;
  const otherExec = (permissions & 0o001) === 0o001;
  const symbolic = [
    (permissions & 0o400) === 0o400 ? 'r' : '-',
    (permissions & 0o200) === 0o200 ? 'w' : '-',
    (permissions & 0o4000) === 0o4000
      ? ownerExec
        ? 's'
        : 'S'
      : ownerExec
        ? 'x'
        : '-',
    (permissions & 0o040) === 0o040 ? 'r' : '-',
    (permissions & 0o020) === 0o020 ? 'w' : '-',
    (permissions & 0o2000) === 0o2000
      ? groupExec
        ? 's'
        : 'S'
      : groupExec
        ? 'x'
        : '-',
    (permissions & 0o004) === 0o004 ? 'r' : '-',
    (permissions & 0o002) === 0o002 ? 'w' : '-',
    (permissions & 0o1000) === 0o1000
      ? otherExec
        ? 't'
        : 'T'
      : otherExec
        ? 'x'
        : '-',
  ].join('');

  return `${permissionTypePrefix(kind)}${symbolic}`;
}

function formatOwner(entry: RemoteFileEntry): string {
  return entry.ownerName?.trim()
    ? entry.ownerName
    : entry.ownerUid !== undefined
      ? `U${entry.ownerUid}`
      : '--';
}

function formatGroup(entry: RemoteFileEntry): string {
  return entry.groupName?.trim()
    ? entry.groupName
    : entry.groupGid !== undefined
      ? `G${entry.groupGid}`
      : '--';
}

const FileIcon: React.FC<{ kind: RemoteFileKind }> = ({ kind }) => {
  if (kind === 'directory') {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        className="h-4 w-4 shrink-0 text-app-warning"
      >
        <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z" />
      </svg>
    );
  }
  if (kind === 'symlink') {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="h-4 w-4 shrink-0 text-app-primary"
      >
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="h-4 w-4 shrink-0 text-app-text-soft"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
};

function NameCellRenderer({ data }: ICellRendererParams<FileEntry>) {
  if (!data) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <FileIcon kind={data.kind} />
      <span className="truncate text-[13px] font-medium leading-5">{data.name}</span>
    </div>
  );
}

export const SftpFileGrid: React.FC<SftpFileGridProps> = ({
  entries,
  side,
  selectedPaths,
  filterQuery,
  batchMode,
  onSelect,
  onDoubleClick,
  onContextMenu,
}) => {
  const { t } = useI18n();
  const gridRef = useRef<AgGridReact>(null);

  const filteredEntries = useMemo(() => {
    if (!filterQuery.trim()) return entries;
    const query = filterQuery.trim().toLowerCase();
    return entries.filter((entry) => entry.name.toLowerCase().includes(query));
  }, [entries, filterQuery]);

  const columnDefs = useMemo<ColDef<FileEntry>[]>(() => {
    const baseColumns: ColDef<FileEntry>[] = [
      {
        cellRenderer: NameCellRenderer,
        field: 'name',
        headerName: t('sftp.columns.name'),
        minWidth: 160,
        flex: 1,
        sortable: true,
        tooltipField: 'name',
      },
      {
        field: 'modifiedAt',
        headerName: t('sftp.columns.time'),
        width: 142,
        minWidth: 142,
        sortable: true,
        valueFormatter: ({ data }) => (data ? formatDate(data.modifiedAt) : '--'),
        cellClass: 'tabular-nums',
      },
      {
        field: 'kind',
        headerName: t('sftp.columns.type'),
        width: 88,
        minWidth: 88,
        sortable: true,
        valueGetter: ({ data }) => {
          if (!data) return '--';
          switch (data.kind) {
            case 'directory':
              return t('sftp.kind.directory');
            case 'file':
              return t('sftp.kind.file');
            case 'symlink':
              return t('sftp.kind.symlink');
            case 'other':
            default:
              return t('sftp.kind.other');
          }
        },
      },
      {
        field: 'size',
        headerName: t('sftp.columns.size'),
        width: 84,
        minWidth: 84,
        sortable: true,
        valueFormatter: ({ data }) =>
          data ? (data.kind === 'directory' ? '--' : formatBytes(data.size)) : '--',
      },
    ];

    if (side === 'remote') {
      baseColumns.push(
        {
          headerName: t('sftp.columns.permissions'),
          width: 148,
          minWidth: 148,
          sortable: true,
          valueGetter: ({ data }) =>
            data && isRemoteEntry(data)
              ? formatPermissionSymbolic(data.permissions, data.kind)
              : '--',
          cellClass: 'font-mono',
        },
        {
          headerName: t('sftp.columns.owner'),
          width: 100,
          minWidth: 88,
          sortable: true,
          valueGetter: ({ data }) =>
            data && isRemoteEntry(data) ? formatOwner(data) : '--',
          cellClass: 'font-mono',
        },
        {
          headerName: t('sftp.columns.group'),
          width: 100,
          minWidth: 88,
          sortable: true,
          valueGetter: ({ data }) =>
            data && isRemoteEntry(data) ? formatGroup(data) : '--',
          cellClass: 'font-mono',
        },
      );
    }

    return baseColumns;
  }, [side, t]);

  const defaultColDef = useMemo<ColDef<FileEntry>>(
    () => ({
      resizable: true,
      suppressMovable: true,
      menuTabs: [],
    }),
    [],
  );

  const rowSelection = useMemo(
    () => ({
      mode: batchMode ? ('multiRow' as const) : ('singleRow' as const),
      checkboxes: batchMode,
      enableClickSelection: true,
    }),
    [batchMode],
  );

  const handleSelectionChanged = (event: SelectionChangedEvent<FileEntry>): void => {
    const selected = event.api.getSelectedRows();
    onSelect(selected.map((row) => row.path));
  };

  const handleRowDoubleClicked = (event: RowDoubleClickedEvent<FileEntry>): void => {
    if (event.data) {
      onDoubleClick(event.data);
    }
  };

  const handleRowClicked = (event: RowClickedEvent<FileEntry>): void => {
    if (!event.data) return;
    if (!batchMode) {
      event.node.setSelected(true);
    }
  };

  const handleCellContextMenu = (
    event: CellContextMenuEvent<FileEntry>,
  ): void => {
    if (!event.data || !event.event) return;
    event.event.preventDefault();
    const mouseEvent = event.event as unknown as React.MouseEvent;
    onContextMenu(event.data, mouseEvent);
  };

  const themeClass = 'ag-theme-quartz';

  return (
    <div className={cn(themeClass, 'h-full w-full')}>
      <AgGridReact
        ref={gridRef}
        rowData={filteredEntries}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        rowSelection={rowSelection}
        rowDragManaged={false}
        domLayout="normal"
        suppressRowClickSelection={false}
        onSelectionChanged={handleSelectionChanged}
        onRowDoubleClicked={handleRowDoubleClicked}
        onRowClicked={handleRowClicked}
        onCellContextMenu={handleCellContextMenu}
        getRowId={(params) => params.data.path}
        tooltipShowDelay={500}
      />
    </div>
  );
};
