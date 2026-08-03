import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import type { SftpSide } from '@/stores/sftpStore';
import type { FileEntry } from './utils';
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
  localMode?: boolean;
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
  localMode = false,
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
  const presentationSide: SftpSide = localMode ? 'local' : side;
  const parentRef = useRef<HTMLDivElement>(null);
  const headerViewportRef = useRef<HTMLDivElement>(null);
  const [sortColumn, setSortColumn] = useState<SftpFileListSortColumn>('name');
  const [sortDirection, setSortDirection] = useState<SftpFileListSortDirection>('default');
  const lastSelectedIndexRef = useRef<number | undefined>(undefined);
  const [focusedIndex, setFocusedIndex] = useState<number | undefined>(undefined);

  // Shift-range selection is anchored to an index into the current listing;
  // drop the anchor whenever the directory or filter reshapes that listing.
  useEffect(() => {
    lastSelectedIndexRef.current = undefined;
  }, [currentPath, filterQuery]);

  // Keyboard focus also indexes into the displayed rows, so drop it whenever
  // the directory, filter, or sorting reshapes that listing.
  useEffect(() => {
    setFocusedIndex(undefined);
  }, [currentPath, filterQuery, sortColumn, sortDirection]);

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
    (entry: FileEntry, e: { shiftKey: boolean }): void => {
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

  // Extend the selection from the shift-range anchor to a sorted-entries
  // index, reusing the same anchor semantics as shift-click.
  const extendSelectionToIndex = useCallback(
    (index: number): void => {
      const anchor = lastSelectedIndexRef.current;
      if (anchor === undefined) {
        const entry = sortedEntries[index];
        if (!entry) return;
        onSelect([entry.path]);
        lastSelectedIndexRef.current = index;
        return;
      }

      const start = Math.min(anchor, index);
      const end = Math.max(anchor, index);
      const range = sortedEntries.slice(start, end + 1);
      const next = new Set(selectedPaths);
      range.forEach((item) => next.add(item.path));
      onSelect(Array.from(next));
    },
    [onSelect, selectedPaths, sortedEntries],
  );

  // Keyboard navigation lives on the list container itself so the filter
  // input (which lives outside this component) keeps its own keys. The dnd
  // context only registers a PointerSensor, so keyboard focus never starts a
  // drag.
  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent): void => {
      if (displayCount === 0) return;
      const parentOffset = showParent ? 1 : 0;
      const focusedEntryIndex =
        focusedIndex === undefined ? undefined : focusedIndex - parentOffset;
      const focusedEntry =
        focusedEntryIndex === undefined || focusedEntryIndex < 0
          ? undefined
          : sortedEntries[focusedEntryIndex];

      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          e.preventDefault();
          const delta = e.key === 'ArrowDown' ? 1 : -1;
          const base = focusedIndex ?? (delta > 0 ? -1 : displayCount);
          const next = Math.min(Math.max(base + delta, 0), displayCount - 1);
          setFocusedIndex(next);
          virtualizer.scrollToIndex(next, { align: 'auto' });
          if (e.shiftKey) {
            const entryIndex = next - parentOffset;
            if (entryIndex >= 0) extendSelectionToIndex(entryIndex);
          }
          break;
        }
        case 'Enter': {
          if (focusedIndex === undefined) break;
          e.preventDefault();
          // The parent row has no entry; Enter mirrors its double-click.
          if (showParent && focusedIndex === 0) {
            handleParentDirectory();
          } else if (focusedEntry) {
            onDoubleClick(focusedEntry);
          }
          break;
        }
        case ' ': {
          if (!focusedEntry) break;
          e.preventDefault();
          handleSelect(focusedEntry, { shiftKey: false });
          break;
        }
        case 'Escape': {
          if (selectedPaths.length === 0) break;
          e.preventDefault();
          onSelect([]);
          break;
        }
      }
    },
    [
      displayCount,
      showParent,
      focusedIndex,
      sortedEntries,
      virtualizer,
      extendSelectionToIndex,
      handleParentDirectory,
      onDoubleClick,
      handleSelect,
      selectedPaths.length,
      onSelect,
    ],
  );

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div
        ref={headerViewportRef}
        data-testid="sftp-file-list-header-viewport"
        className="shrink-0 overflow-hidden"
      >
        <SftpFileListHeader
          side={presentationSide}
          sortColumn={sortColumn}
          sortDirection={sortDirection}
          onSort={handleSort}
        />
      </div>
      <ScrollArea
        className="relative flex-1 outline-none"
        viewportRef={parentRef}
        horizontal
        role="listbox"
        aria-multiselectable={batchMode || undefined}
        tabIndex={0}
        onKeyDown={handleListKeyDown}
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
                  role="option"
                  aria-selected={isParent ? false : selectedSet.has(entry!.path)}
                  className={cn(
                    'absolute left-0 w-full',
                    focusedIndex === virtualItem.index && 'ring-1 ring-inset ring-app-primary',
                  )}
                  style={{
                    top: `${virtualItem.start}px`,
                    height: `${virtualItem.size}px`,
                  }}
                  data-testid={isParent ? 'sftp-parent-row' : 'sftp-row'}
                >
                  {isParent ? (
                    <SftpParentRow
                      side={presentationSide}
                      batchMode={batchMode}
                      onParentDirectory={handleParentDirectory}
                      onBlankContextMenu={onBlankContextMenu}
                    />
                  ) : (
                    <SftpFileListRow
                      entry={entry!}
                      side={side}
                      presentationSide={presentationSide}
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
