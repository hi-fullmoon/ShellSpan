import React from 'react';
import { useDraggable } from '@dnd-kit/core';
import { cn, formatBytes, formatDate, formatPermissions } from '@/lib/utils';
import type { LocalFileEntry, RemoteFileEntry } from '@/types';
import type { SftpDndPayload } from './SftpDndContext';

export type FileEntry = LocalFileEntry | RemoteFileEntry;

export interface FileGridProps {
  entries: FileEntry[];
  selectedPaths: Set<string>;
  side: 'local' | 'remote';
  onSelect: (path: string, multi: boolean) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onContextMenu: (entry: FileEntry, e: React.MouseEvent) => void;
  loading?: boolean;
}

export const FileGrid: React.FC<FileGridProps> = ({
  entries,
  selectedPaths,
  side,
  onSelect,
  onDoubleClick,
  onContextMenu,
  loading,
}) => {
  const selectedEntries = entries.filter((entry) =>
    selectedPaths.has(entry.path),
  );

  return (
    <div className="flex h-full flex-col overflow-auto">
      <div className="sticky top-0 z-10 grid h-7 grid-cols-[1fr_80px_100px_80px] items-center border-b border-app-border bg-app-surface-muted px-2 text-[11px] font-semibold uppercase tracking-wide text-app-text-soft">
        <span>Name</span>
        <span className="text-right">Size</span>
        <span className="text-right">Modified</span>
        <span className="text-right">Mode</span>
      </div>
      {loading && entries.length === 0 && (
        <div className="flex h-20 items-center justify-center text-xs text-app-text-soft">
          Loading...
        </div>
      )}
      {entries.map((entry) => (
        <FileRow
          key={entry.path}
          entry={entry}
          side={side}
          selected={selectedPaths.has(entry.path)}
          dragPayload={
            selectedPaths.has(entry.path)
              ? { side, entries: selectedEntries }
              : { side, entries: [entry] }
          }
          onSelect={() => onSelect(entry.path, false)}
          onDoubleClick={() => onDoubleClick(entry)}
          onContextMenu={(e) => onContextMenu(entry, e)}
        />
      ))}
    </div>
  );
};

interface FileRowProps {
  entry: FileEntry;
  side: 'local' | 'remote';
  selected: boolean;
  dragPayload: SftpDndPayload;
  onSelect: () => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

const FileRow: React.FC<FileRowProps> = ({
  entry,
  side,
  selected,
  dragPayload,
  onSelect,
  onDoubleClick,
  onContextMenu,
}) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: `file-${side}-${entry.path}`,
      data: dragPayload,
    });

  const style: React.CSSProperties = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    opacity: isDragging ? 0.5 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      className={cn(
        'grid h-8 cursor-pointer grid-cols-[1fr_80px_100px_80px] items-center border-b border-app-border px-2 text-xs transition-colors',
        selected
          ? 'bg-app-primary/10 text-app-primary'
          : 'hover:bg-app-surface-muted',
      )}
    >
      <div className="flex items-center gap-2 overflow-hidden">
        <FileIcon kind={entry.kind} />
        <span className="truncate font-medium">{entry.name}</span>
      </div>
      <span className="text-right text-app-text-soft">
        {formatBytes(entry.size)}
      </span>
      <span className="text-right text-app-text-soft">
        {formatDate(entry.modifiedAt)}
      </span>
      <span className="text-right font-mono text-app-text-soft">
        {'permissions' in entry ? formatPermissions(entry.permissions) : '-'}
      </span>
    </div>
  );
};

const FileIcon: React.FC<{ kind: string }> = ({ kind }) => {
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
