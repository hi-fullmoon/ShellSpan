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
  const handleClick = (e: React.MouseEvent): void => {
    e.preventDefault();
    onParentDirectory();
  };

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
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      className={cn(
        'grid cursor-default select-none items-center border-b border-app-border/50 px-2 text-xs transition-colors hover:bg-app-surface-muted text-app-text',
      )}
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
        <FolderUpIcon className="h-4 w-4 shrink-0 text-app-text-soft" />
        <span className="truncate text-[13px] font-medium">..</span>
      </div>
      <div className="truncate pr-2 text-app-text-soft">--</div>
      <div className="truncate pr-2 text-app-text-soft">--</div>
      <div className="truncate pr-2 text-app-text-soft">--</div>
      {side === 'remote' && (
        <>
          <div className="truncate pr-2 text-app-text-soft">--</div>
          <div className="truncate pr-2 text-app-text-soft">--</div>
        </>
      )}
    </div>
  );
};
