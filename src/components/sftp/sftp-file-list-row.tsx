import React, { useMemo } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { cn, formatBytes, formatDate } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import type { RemoteFileKind } from '@/types';
import type { SftpSide } from '@/stores/sftpStore';
import type { FileEntry } from './file-entry-formatters';
import {
  formatGroup,
  formatOwner,
  formatPermissionSymbolic,
  isRemoteEntry,
} from './file-entry-formatters';
import type { SftpDndPayload } from './sftp-dnd-context';

export interface SftpFileListRowProps {
  entry: FileEntry;
  side: SftpSide;
  selected: boolean;
  batchMode: boolean;
  selectedEntries: FileEntry[];
  onSelect: (entry: FileEntry, e: React.MouseEvent) => void;
  onDoubleClick: (entry: FileEntry) => void;
  onContextMenu: (entry: FileEntry, e: React.MouseEvent) => void;
}

export const FileIcon: React.FC<{ kind: RemoteFileKind }> = ({ kind }) => {
  if (kind === 'directory') {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="currentColor"
        className="h-4 w-4 shrink-0 text-app-primary"
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

function getKindLabel(
  kind: RemoteFileKind,
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (kind) {
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
}

export const SftpFileListRow: React.FC<SftpFileListRowProps> = ({
  entry,
  side,
  selected,
  batchMode,
  selectedEntries,
  onSelect,
  onDoubleClick,
  onContextMenu,
}) => {
  const { t } = useI18n();

  const dragPayload: SftpDndPayload = useMemo(() => {
    const entries = selected ? selectedEntries : [entry];
    return { side, entries };
  }, [selected, selectedEntries, entry, side]);

  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `sftp-row-${side}-${entry.path}`,
    data: dragPayload,
    disabled: false,
  });

  const handleClick = (e: React.MouseEvent): void => {
    e.preventDefault();
    onSelect(entry, e);
  };

  const handleDoubleClick = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    onDoubleClick(entry);
  };

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    onContextMenu(entry, e);
  };

  const remote = isRemoteEntry(entry);
  const permissionText = remote
    ? formatPermissionSymbolic(entry.permissions, entry.kind)
    : undefined;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      className={cn(
        'grid cursor-default select-none items-center border-b border-app-border/50 px-2 text-xs transition-colors',
        selected
          ? 'bg-app-primary/[0.12] text-app-text'
          : 'hover:bg-app-primary/[0.08] text-app-text',
        isDragging && 'opacity-50',
      )}
      style={{
        gridTemplateColumns:
          side === 'remote'
            ? '1fr 148px 88px 96px 88px 88px'
            : '1fr 148px 88px 96px',
      }}
    >
      <div className="flex h-[34px] min-w-0 items-center gap-1.5 pr-2">
        {batchMode && (
          <input
            type="checkbox"
            readOnly
            checked={selected}
            className="h-3.5 w-3.5 shrink-0 accent-app-primary"
          />
        )}
        <FileIcon kind={entry.kind} />
        <div className="flex min-w-0 flex-col justify-center leading-tight">
          <span className="truncate text-[13px] font-medium">{entry.name}</span>
          {permissionText && (
            <span className="truncate font-mono text-[11px] text-app-text-soft">
              {permissionText}
            </span>
          )}
        </div>
      </div>

      <div className="truncate pr-2 tabular-nums text-app-text-soft">
        {entry.modifiedAt ? formatDate(entry.modifiedAt) : '--'}
      </div>

      <div className="truncate pr-2 tabular-nums text-app-text-soft">
        {entry.kind === 'directory' ? '--' : formatBytes(entry.size)}
      </div>

      <div className="truncate pr-2 text-app-text-soft">{getKindLabel(entry.kind, t)}</div>

      {side === 'remote' && remote && (
        <>
          <div className="truncate pr-2 font-mono text-app-text-soft">
            {formatOwner(entry)}
          </div>
          <div className="truncate pr-2 font-mono text-app-text-soft">
            {formatGroup(entry)}
          </div>
        </>
      )}
    </div>
  );
};
