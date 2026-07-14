import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import type { SftpSide } from '@/stores/sftpStore';
import type { FileEntry } from './fileEntryFormatters';
import {
  SftpFileListHeader,
  type SftpFileListSortColumn,
  type SftpFileListSortDirection,
} from './SftpFileListHeader';
import { SftpFileListRow } from './SftpFileListRow';

export interface SftpFileListProps {
  entries: FileEntry[];
  side: SftpSide;
  selectedPaths: string[];
  filterQuery: string;
  batchMode: boolean;
  onSelect: (paths: string[]) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onContextMenu: (entry: FileEntry, e: React.MouseEvent) => void;
}

function compareEntries(
  a: FileEntry,
  b: FileEntry,
  column: SftpFileListSortColumn,
  direction: SftpFileListSortDirection,
): number {
  // Directories always sort before files when sorting by name or kind.
  if (column === 'name' || column === 'kind') {
    if (a.kind === 'directory' && b.kind !== 'directory') return -1;
    if (a.kind !== 'directory' && b.kind === 'directory') return 1;
  }

  let comparison = 0;
  switch (column) {
    case 'name':
      comparison = a.name.localeCompare(b.name);
      break;
    case 'modifiedAt': {
      const ma = a.modifiedAt ?? 0;
      const mb = b.modifiedAt ?? 0;
      comparison = ma - mb;
      break;
    }
    case 'size': {
      const sa = a.size ?? 0;
      const sb = b.size ?? 0;
      comparison = sa - sb;
      break;
    }
    case 'kind':
      comparison = a.kind.localeCompare(b.kind);
      break;
  }

  return direction === 'asc' ? comparison : -comparison;
}

export const SftpFileList: React.FC<SftpFileListProps> = ({
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
  const parentRef = useRef<HTMLDivElement>(null);
  const [sortColumn, setSortColumn] = useState<SftpFileListSortColumn>('name');
  const [sortDirection, setSortDirection] = useState<SftpFileListSortDirection>('asc');
  const lastSelectedIndexRef = useRef<number | undefined>(undefined);

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);

  const filteredEntries = useMemo(() => {
    const query = filterQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(query),
    );
  }, [entries, filterQuery]);

  const sortedEntries = useMemo(() => {
    return [...filteredEntries].sort((a, b) =>
      compareEntries(a, b, sortColumn, sortDirection),
    );
  }, [filteredEntries, sortColumn, sortDirection]);

  const virtualizer = useVirtualizer({
    count: sortedEntries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 8,
  });

  const selectedEntries = useMemo(
    () => sortedEntries.filter((entry) => selectedSet.has(entry.path)),
    [sortedEntries, selectedSet],
  );

  const handleSort = useCallback((column: SftpFileListSortColumn): void => {
    setSortColumn((current) => {
      if (current === column) {
        setSortDirection((dir) => (dir === 'asc' ? 'desc' : 'asc'));
        return current;
      }
      setSortDirection('asc');
      return column;
    });
  }, []);

  const handleSelect = useCallback(
    (entry: FileEntry, e: React.MouseEvent): void => {
      const index = sortedEntries.findIndex((item) => item.path === entry.path);
      const isMeta = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;

      if (batchMode) {
        if (isShift && lastSelectedIndexRef.current !== undefined) {
          const start = Math.min(lastSelectedIndexRef.current, index);
          const end = Math.max(lastSelectedIndexRef.current, index);
          const range = sortedEntries.slice(start, end + 1);
          const next = new Set(selectedPaths);
          range.forEach((item) => next.add(item.path));
          onSelect(Array.from(next));
          return;
        }

        if (isMeta) {
          const next = new Set(selectedPaths);
          if (next.has(entry.path)) {
            next.delete(entry.path);
          } else {
            next.add(entry.path);
          }
          onSelect(Array.from(next));
          lastSelectedIndexRef.current = index;
          return;
        }

        // Plain click in batch mode replaces selection with the single item.
        onSelect([entry.path]);
        lastSelectedIndexRef.current = index;
        return;
      }

      onSelect([entry.path]);
      lastSelectedIndexRef.current = index;
    },
    [batchMode, onSelect, selectedPaths, sortedEntries],
  );

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <SftpFileListHeader
        side={side}
        sortColumn={sortColumn}
        sortDirection={sortDirection}
        onSort={handleSort}
      />
      <div
        ref={parentRef}
        className="relative flex-1 overflow-auto"
        onContextMenu={(e) => e.preventDefault()}
      >
        {sortedEntries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-app-text-soft">
            {filterQuery.trim()
              ? t('sftp.filteredEmpty')
              : t('sftp.emptyFolder')}
          </div>
        ) : (
          <div
            className="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualItems.map((virtualItem) => {
              const entry = sortedEntries[virtualItem.index];
              const selected = selectedSet.has(entry.path);
              return (
                <div
                  key={entry.path}
                  className="absolute left-0 w-full"
                  style={{
                    top: `${virtualItem.start}px`,
                    height: `${virtualItem.size}px`,
                  }}
                >
                  <SftpFileListRow
                    entry={entry}
                    side={side}
                    selected={selected}
                    batchMode={batchMode}
                    selectedEntries={selectedEntries}
                    onSelect={handleSelect}
                    onDoubleClick={onDoubleClick}
                    onContextMenu={onContextMenu}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
