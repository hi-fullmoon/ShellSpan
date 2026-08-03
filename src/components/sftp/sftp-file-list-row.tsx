import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { FolderIcon, LinkIcon, FileIcon as LucideFileIcon } from 'lucide-react';
import { cn, formatBytes, formatDate } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { RemoteFileKind } from '@/types';
import type { SftpSide } from '@/stores/sftpStore';
import type { FileEntry } from './utils';
import {
  formatGroup,
  formatOwner,
  formatPermissionSymbolic,
  isRemoteEntry,
} from './utils';
import type { SftpDndPayload } from './sftp-dnd-context';

export interface SftpFileListRowProps {
  entry: FileEntry;
  side: SftpSide;
  presentationSide?: SftpSide;
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
  presentationSide = side,
  selected,
  batchMode,
  selectedEntries,
  onSelect,
  onDoubleClick,
  onContextMenu,
}) => {
  const { t } = useI18n();
  const fileNameRef = useRef<HTMLSpanElement>(null);
  const [isFileNameTruncated, setIsFileNameTruncated] = useState(false);

  const updateFileNameTruncation = useCallback(() => {
    const element = fileNameRef.current;
    if (!element) return;
    const nextIsTruncated = element.scrollWidth > element.clientWidth;
    setIsFileNameTruncated((current) =>
      current === nextIsTruncated ? current : nextIsTruncated,
    );
  }, []);

  useLayoutEffect(() => {
    updateFileNameTruncation();
    const element = fileNameRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(updateFileNameTruncation);
    observer.observe(element);
    return () => observer.disconnect();
  }, [entry.name, updateFileNameTruncation]);

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
    // On the second click of a double-click sequence (detail=2), skip the
    // single-click action and let handleDoubleClick take over. This prevents
    // onSelect from firing twice before onDoubleClick.
    if (e.detail === 2) {
      return;
    }
    onSelect(entry, e);
  };

  const handleDoubleClick = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    onDoubleClick(entry);
  };

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(entry, e);
  };

  const remote = isRemoteEntry(entry);
  const permissionText = remote
    ? formatPermissionSymbolic(entry.permissions, entry.kind)
    : undefined;
  const mutedTextClass = selected ? 'text-app-primary' : 'text-app-text-soft';
  const cellStateClass = cn(
    'border-b border-app-border/50 transition-colors',
    selected ? 'bg-app-primary/10' : 'group-hover:bg-app-surface-muted',
  );

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      className={cn(
        'group grid h-full cursor-default select-none items-center px-2 text-xs',
        isDragging && 'opacity-50',
      )}
      style={{
        gridTemplateColumns:
          presentationSide === 'remote'
            ? 'minmax(300px, 1fr) 148px 88px 96px 88px 88px'
            : 'minmax(300px, 1fr) 148px 88px 96px',
      }}
    >
      <div
        data-sftp-file-cell
        className={cn(
          'flex h-full min-w-0 items-center gap-1.5 -ml-2 pr-2 pl-2',
          cellStateClass,
          selected ? 'text-app-primary' : 'text-app-text',
        )}
      >
        {batchMode && (
          <Checkbox checked={selected} className="h-3.5 w-3.5 shrink-0" />
        )}
        <FileIcon kind={entry.kind} selected={selected} />
        <div className="flex min-w-0 flex-col justify-center leading-tight">
          <Tooltip disabled={!isFileNameTruncated}>
            <TooltipTrigger
              delay={0}
              render={
                <span
                  ref={fileNameRef}
                  className="truncate text-[13px] font-medium"
                  onMouseEnter={updateFileNameTruncation}
                />
              }
            >
              {entry.name}
            </TooltipTrigger>
            <TooltipContent className="break-all">{entry.name}</TooltipContent>
          </Tooltip>
          {permissionText && (
            <span className={cn('truncate font-mono text-[11px]', mutedTextClass)}>
              {permissionText}
            </span>
          )}
        </div>
      </div>

      <div data-sftp-file-cell className={cn('flex h-full items-center truncate pr-2 tabular-nums', cellStateClass, mutedTextClass)}>
        {entry.modifiedAt ? formatDate(entry.modifiedAt) : '--'}
      </div>

      <div data-sftp-file-cell className={cn('flex h-full items-center truncate pr-2 tabular-nums', cellStateClass, mutedTextClass)}>
        {entry.kind === 'directory' ? '--' : formatBytes(entry.size)}
      </div>

      <div
        data-sftp-file-cell
        className={cn(
          'flex h-full items-center truncate pr-2',
          presentationSide === 'local' && '-mr-2',
          cellStateClass,
          mutedTextClass,
        )}
      >
        {getKindLabel(entry.kind, t)}
      </div>

      {presentationSide === 'remote' && remote && (
        <>
          <div data-sftp-file-cell className={cn('flex h-full items-center truncate pr-2 font-mono', cellStateClass, mutedTextClass)}>
            {formatOwner(entry)}
          </div>
          <div data-sftp-file-cell className={cn('flex h-full items-center truncate -mr-2 pr-2 font-mono', cellStateClass, mutedTextClass)}>
            {formatGroup(entry)}
          </div>
        </>
      )}
    </div>
  );
};
