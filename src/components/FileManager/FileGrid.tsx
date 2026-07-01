import { useEffect, useMemo, useRef } from 'react';
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
import { getActiveLocale, t } from '../../lib/i18n';
import { cn, fileKindColor } from '../../lib/ui';
import { FileIcon, FolderIcon, LinkIcon, DotsIcon } from '../Icons';
import { ScrollArea } from '../ScrollArea';
import { formatGroup, formatModified, formatOwner, formatPermissionSymbolic, formatSize, kindLabel } from './lib/formatters';
import type { RemoteFileEntry, RemoteFileKind } from '../../types';

ModuleRegistry.registerModules([AllCommunityModule]);

interface FileGridProps {
  loading: boolean;
  listing?: { entries: RemoteFileEntry[]; path: string; parentPath?: string };
  filteredEntries: RemoteFileEntry[];
  selectedPaths: string[];
  onRowClick: (entry: RemoteFileEntry) => void;
  onRowDoubleClick: (entry: RemoteFileEntry) => void;
  onContextMenu: (event: CellContextMenuEvent<RemoteFileEntry>) => void;
  onSelectionChanged: (event: SelectionChangedEvent<RemoteFileEntry>) => void;
  onBlankContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
  onClearSelection: () => void;
}

function fileKindIcon(kind: RemoteFileKind) {
  switch (kind) {
    case 'directory':
      return <FolderIcon />;
    case 'symlink':
      return <LinkIcon />;
    case 'other':
      return <DotsIcon />;
    default:
      return <FileIcon />;
  }
}

function NameCellRenderer({ data }: ICellRendererParams<RemoteFileEntry>) {
  if (!data) return null;
  const isHidden = data.name.startsWith('.');
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className={cn('inline-flex h-5 w-5 shrink-0 items-center justify-center', fileKindColor(data.kind))}>
        {fileKindIcon(data.kind)}
      </span>
      <span
        className={cn(
          'truncate text-[13px] font-medium leading-5 tracking-[0.01em]',
          isHidden ? 'text-[var(--fm-hidden)]' : 'text-[var(--fm-text)]',
        )}
      >
        {data.name}
      </span>
    </div>
  );
}

export function FileGrid(props: FileGridProps) {
  const gridRef = useRef<AgGridReact<RemoteFileEntry>>(null);
  const locale = getActiveLocale();

  const columnDefs = useMemo<ColDef<RemoteFileEntry>[]>(
    () => [
      { cellRenderer: NameCellRenderer, field: 'name', headerName: t('fileManager.columns.name'), width: 240, minWidth: 160, resizable: true, suppressMovable: true, tooltipField: 'name', flex: 1 },
      { field: 'modifiedAt', headerName: t('fileManager.columns.time'), width: 142, minWidth: 142, resizable: true, suppressMovable: true, valueFormatter: ({ data }) => (data ? formatModified(data.modifiedAt) : '--'), cellClass: 'tabular-nums' },
      { field: 'kind', headerName: t('fileManager.columns.type'), width: 72, minWidth: 72, resizable: true, suppressMovable: true, valueGetter: ({ data }) => (data ? kindLabel(data.kind) : '--'), valueFormatter: ({ data }) => (data ? kindLabel(data.kind) : '--') },
      { field: 'size', headerName: t('fileManager.columns.size'), width: 80, minWidth: 80, resizable: true, suppressMovable: true, valueFormatter: ({ data }) => (data ? (data.kind === 'directory' ? '--' : formatSize(data.size)) : '--') },
      { headerName: t('fileManager.columns.permissions'), width: 120, minWidth: 120, resizable: true, suppressMovable: true, valueGetter: ({ data }) => (data ? formatPermissionSymbolic(data.permissions, data.kind) : '--'), valueFormatter: ({ data }) => (data ? formatPermissionSymbolic(data.permissions, data.kind) : '--'), cellClass: 'font-mono' },
      { headerName: t('fileManager.columns.owner'), width: 80, minWidth: 80, resizable: true, suppressMovable: true, valueGetter: ({ data }) => (data ? formatOwner(data) : '--'), valueFormatter: ({ data }) => (data ? formatOwner(data) : '--'), cellClass: 'font-mono' },
      { headerName: t('fileManager.columns.group'), width: 80, minWidth: 80, resizable: true, suppressMovable: true, valueGetter: ({ data }) => (data ? formatGroup(data) : '--'), valueFormatter: ({ data }) => (data ? formatGroup(data) : '--'), cellClass: 'font-mono' },
    ],
    [locale],
  );

  const defaultColDef = useMemo<ColDef<RemoteFileEntry>>(() => ({ sortable: true, menuTabs: [], unSortIcon: true }), []);

  useEffect(() => {
    const api = gridRef.current?.api;
    if (!api) return;
    const paths = new Set(props.selectedPaths);
    let hasSelectedRow = false;
    api.forEachNode((node) => {
      const shouldSelect = node.data ? paths.has(node.data.path) : false;
      if (node.isSelected() !== shouldSelect) node.setSelected(shouldSelect);
      if (shouldSelect) hasSelectedRow = true;
    });
    if (!hasSelectedRow && api.getSelectedRows().length) api.deselectAll();
  }, [props.selectedPaths, props.listing]);

  if (!props.listing) return null;

  return (
    <ScrollArea
      className="flex-1"
      onContextMenu={props.onBlankContextMenu}
      onMouseDown={(event) => {
        if (event.button === 2) event.preventDefault();
      }}
    >
      <div className="termbridge-file-grid ag-theme-quartz termbridge-file-grid h-full">
        <AgGridReact<RemoteFileEntry>
          animateRows={false}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={(params) => params.data.path}
          headerHeight={28}
          noRowsOverlayComponentParams={{ message: t('fileManager.emptyDirectory') }}
          onCellContextMenu={props.onContextMenu}
          onRowClicked={(event: RowClickedEvent<RemoteFileEntry>) => {
            if (event.data) props.onRowClick(event.data);
          }}
          onRowDoubleClicked={(event: RowDoubleClickedEvent<RemoteFileEntry>) => {
            if (event.data) props.onRowDoubleClick(event.data);
          }}
          onSelectionChanged={props.onSelectionChanged}
          overlayNoRowsTemplate={`<span class="termbridge-grid-overlay">${t('fileManager.emptyDirectory')}</span>`}
          ref={gridRef}
          rowData={props.filteredEntries}
          rowHeight={32}
          rowSelection={{ mode: 'multiRow', checkboxes: true, enableClickSelection: true }}
          selectionColumnDef={{ width: 28, minWidth: 28, maxWidth: 28, suppressSizeToFit: true, resizable: false }}
          suppressCellFocus
          suppressContextMenu
          suppressDragLeaveHidesColumns
          theme="legacy"
        />
      </div>
    </ScrollArea>
  );
}
