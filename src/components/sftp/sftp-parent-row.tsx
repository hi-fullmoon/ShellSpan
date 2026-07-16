import React from 'react';
import { FolderUpIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SftpSide } from '@/stores/sftpStore';

export interface SftpParentRowProps {
  side: SftpSide;
  batchMode: boolean;
  onParentDirectory: () => void;
  onBlankContextMenu?: (e: React.MouseEvent) => void;
}

export const SftpParentRow: React.FC<SftpParentRowProps> = ({
  side,
  batchMode,
  onParentDirectory,
  onBlankContextMenu,
}) => {
  const handleDoubleClick = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    onParentDirectory();
  };

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    onBlankContextMenu?.(e);
  };

  const cellClass = 'flex h-full items-center border-b border-app-border/50 transition-colors group-hover:bg-app-surface-muted';

  return (
    <div
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      className="group grid h-full cursor-default select-none items-center px-2 text-xs"
      style={{
        gridTemplateColumns:
          side === 'remote'
            ? 'minmax(300px, 1fr) 148px 88px 96px 88px 88px'
            : 'minmax(300px, 1fr) 148px 88px 96px',
      }}
      data-testid="sftp-parent-row"
    >
      <div data-sftp-file-cell className={cn(cellClass, 'min-w-0 gap-1.5 -ml-2 pr-2 pl-2 text-app-text')}>
        {batchMode && <div className="h-3.5 w-3.5 shrink-0" />}
        <FolderUpIcon className="h-4 w-4 shrink-0 text-app-primary" />
        <span className="truncate text-[13px] font-medium">..</span>
      </div>
      <div data-sftp-file-cell className={cellClass} />
      <div data-sftp-file-cell className={cellClass} />
      <div data-sftp-file-cell className={cn(cellClass, side === 'local' && '-mr-2')} />
      {side === 'remote' && (
        <>
          <div data-sftp-file-cell className={cellClass} />
          <div data-sftp-file-cell className={cn(cellClass, '-mr-2')} />
        </>
      )}
    </div>
  );
};
