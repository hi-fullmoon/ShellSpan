import React, { useMemo } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { FolderIcon, LinkIcon, FileIcon as LucideFileIcon } from 'lucide-react';
import { cn, formatBytes, formatDate } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Checkbox } from '@/components/ui/checkbox';
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

export const FileIcon: React.FC<{ kind: RemoteFileKind; selected?: boolean }> = ({ kind, selected }) => {
  if (kind === 'directory') {
    return <FolderIcon className="h-4 w-4 shrink-0 text-app-primary" />;
  }
  if (kind === 'symlink') {
    return <LinkIcon className="h-4 w-4 shrink-0 text-app-primary" />;
  }
  return <LucideFileIcon className={cn('h-4 w-4 shrink-0', selected ? 'text-app-primary' : 'text-app-text-soft')} />;
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
  const mutedTextClass = selected ? 'text-app-primary' : 'text-app-text-soft';

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
          ? 'bg-app-primary/10 text-app-primary'
          : 'hover:bg-app-surface-muted text-app-text',
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
          <Checkbox checked={selected} className="h-3.5 w-3.5 shrink-0" />
        )}
        <FileIcon kind={entry.kind} selected={selected} />
        <div className="flex min-w-0 flex-col justify-center leading-tight">
          <span className="truncate text-[13px] font-medium">{entry.name}</span>
          {permissionText && (
            <span className={cn('truncate font-mono text-[11px]', mutedTextClass)}>
              {permissionText}
            </span>
          )}
        </div>
      </div>

      <div className={cn('truncate pr-2 tabular-nums', mutedTextClass)}>
        {entry.modifiedAt ? formatDate(entry.modifiedAt) : '--'}
      </div>

      <div className={cn('truncate pr-2 tabular-nums', mutedTextClass)}>
        {entry.kind === 'directory' ? '--' : formatBytes(entry.size)}
      </div>

      <div className={cn('truncate pr-2', mutedTextClass)}>{getKindLabel(entry.kind, t)}</div>

      {side === 'remote' && remote && (
        <>
          <div className={cn('truncate pr-2 font-mono', mutedTextClass)}>
            {formatOwner(entry)}
          </div>
          <div className={cn('truncate pr-2 font-mono', mutedTextClass)}>
            {formatGroup(entry)}
          </div>
        </>
      )}
    </div>
  );
};
