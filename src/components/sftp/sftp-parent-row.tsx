import React from 'react';
import { FolderUpIcon } from 'lucide-react';
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

  return (
    <div
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      className="grid h-full cursor-default select-none items-center border-b border-app-border/50 px-2 text-xs text-app-text transition-colors hover:bg-app-surface-muted"
      style={{
        gridTemplateColumns:
          side === 'remote'
            ? 'minmax(120px, 1fr) 148px 88px 96px 88px 88px'
            : 'minmax(120px, 1fr) 148px 88px 96px',
      }}
      data-testid="sftp-parent-row"
    >
      <div className="flex h-[34px] min-w-0 items-center gap-1.5 pr-2">
        {batchMode && <div className="h-3.5 w-3.5 shrink-0" />}
        <FolderUpIcon className="h-4 w-4 shrink-0 text-app-primary" />
        <span className="truncate text-[13px] font-medium">..</span>
      </div>
      <div />
      <div />
      <div />
      {side === 'remote' && (
        <>
          <div />
          <div />
        </>
      )}
    </div>
  );
};
