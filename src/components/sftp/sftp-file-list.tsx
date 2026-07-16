import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import type { SftpSide } from '@/stores/sftpStore';
import type { FileEntry } from './file-entry-formatters';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  SftpFileListHeader,
  type SftpFileListSortColumn,
  type SftpFileListSortDirection,
} from './sftp-file-list-header';
import { SftpParentRow } from './sftp-parent-row';
import { SftpFileListRow } from './sftp-file-list-row';
import { isPortableRootPath } from '@/lib/path-utils';

export interface SftpFileListProps {
  entries: FileEntry[];
  side: SftpSide;
  selectedPaths: string[];
  filterQuery: string;
  batchMode: boolean;
  currentPath?: string;
  onSelect: (paths: string[]) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onContextMenu: (entry: FileEntry, e: React.MouseEvent) => void;
  onBlankContextMenu?: (e: React.MouseEvent) => void;
  onParentDirectory?: () => void;
}

function isRootPath(currentPath?: string): boolean {
  return isPortableRootPath(currentPath);
}

function compareEntries(
  a: FileEntry,
  b: FileEntry,
  column: SftpFileListSortColumn,
  direction: 'asc' | 'desc',
): number {
  // Keep directories first for name sorting. Kind sorting must honor the
  // selected direction so ascending and descending produce distinct orders.
  if (column === 'name') {
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
  currentPath,
  onSelect,
  onDoubleClick,
  onContextMenu,
  onBlankContextMenu,
  onParentDirectory,
}) => {
  const { t } = useI18n();
  const parentRef = useRef<HTMLDivElement>(null);
  const headerViewportRef = useRef<HTMLDivElement>(null);
  const [sortColumn, setSortColumn] = useState<SftpFileListSortColumn>('name');
  const [sortDirection, setSortDirection] = useState<SftpFileListSortDirection>('default');
  const lastSelectedIndexRef = useRef<number | undefined>(undefined);

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);

  const filteredEntries = useMemo(() => {
    const query = filterQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(query),
    );
  }, [entries, filterQuery]);

  const sortedEntries = useMemo(() => {
    if (sortDirection === 'default') {
      return [...filteredEntries].sort((a, b) => compareEntries(a, b, 'name', 'asc'));
    }
    return [...filteredEntries].sort((a, b) => compareEntries(a, b, sortColumn, sortDirection));
  }, [filteredEntries, sortColumn, sortDirection]);

  const showParent = useMemo(() => !isRootPath(currentPath), [currentPath]);
  const displayCount = showParent ? sortedEntries.length + 1 : sortedEntries.length;

  const virtualizer = useVirtualizer({
    count: displayCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 8,
  });

  useEffect(() => {
    const contentViewport = parentRef.current;
    const headerViewport = headerViewportRef.current;
    if (!contentViewport || !headerViewport) return;

    const syncHeaderScroll = (): void => {
      headerViewport.scrollLeft = contentViewport.scrollLeft;
    };

    syncHeaderScroll();
    contentViewport.addEventListener('scroll', syncHeaderScroll, { passive: true });
    return () => contentViewport.removeEventListener('scroll', syncHeaderScroll);
  }, []);

  const selectedEntries = useMemo(
    () => sortedEntries.filter((entry) => selectedSet.has(entry.path)),
    [sortedEntries, selectedSet],
  );

  const handleSort = useCallback((column: SftpFileListSortColumn): void => {
    setSortColumn((current) => {
      if (current === column) {
        setSortDirection((dir) => {
          if (dir === 'asc') return 'desc';
          if (dir === 'desc') return 'default';
          return 'asc';
        });
        return current;
      }
      setSortDirection('asc');
      return column;
    });
  }, []);

  const handleSelect = useCallback(
    (entry: FileEntry, e: React.MouseEvent): void => {
      const index = sortedEntries.findIndex((item) => item.path === entry.path);
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

      onSelect([entry.path]);
      lastSelectedIndexRef.current = index;
    },
    [batchMode, onSelect, selectedPaths, sortedEntries],
  );

  const handleParentDirectory = useCallback(() => {
    onParentDirectory?.();
  }, [onParentDirectory]);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div
        ref={headerViewportRef}
        data-testid="sftp-file-list-header-viewport"
        className="shrink-0 overflow-hidden"
      >
        <SftpFileListHeader
          side={side}
          sortColumn={sortColumn}
          sortDirection={sortDirection}
          onSort={handleSort}
        />
      </div>
      <ScrollArea
        className="relative flex-1"
        viewportRef={parentRef}
        horizontal
        onContextMenu={(e) => {
          e.preventDefault();
          onBlankContextMenu?.(e);
        }}
      >
        {displayCount === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-app-text-soft">
            {filterQuery.trim()
              ? t('sftp.filteredEmpty')
              : t('sftp.emptyFolder')}
          </div>
        ) : (
          <div
            className="relative w-full"
            style={{
              height: `${virtualizer.getTotalSize() + (batchMode ? 56 : 0)}px`,
            }}
          >
            {virtualItems.map((virtualItem) => {
              const isParent = showParent && virtualItem.index === 0;
              const entry = isParent
                ? null
                : sortedEntries[virtualItem.index - (showParent ? 1 : 0)];

              return (
                <div
                  key={isParent ? '..' : entry!.path}
                  className="absolute left-0 w-full"
                  style={{
                    top: `${virtualItem.start}px`,
                    height: `${virtualItem.size}px`,
                  }}
                  data-testid={isParent ? 'sftp-parent-row' : 'sftp-row'}
                >
                  {isParent ? (
                    <SftpParentRow
                      side={side}
                      batchMode={batchMode}
                      onParentDirectory={handleParentDirectory}
                      onBlankContextMenu={onBlankContextMenu}
                    />
                  ) : (
                    <SftpFileListRow
                      entry={entry!}
                      side={side}
                      selected={selectedSet.has(entry!.path)}
                      batchMode={batchMode}
                      selectedEntries={selectedEntries}
                      onSelect={handleSelect}
                      onDoubleClick={onDoubleClick}
                      onContextMenu={onContextMenu}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
};
