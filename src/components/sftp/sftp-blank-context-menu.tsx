import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  FilePlusIcon,
  FolderPlusIcon,
  UploadIcon,
  FolderUpIcon,
  ClipboardPasteIcon,
  CopyIcon,
  Grid3X3Icon,
  RefreshCwIcon,
  BookmarkIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import { useViewportConstrainedPosition } from '@/hooks/useViewportConstrainedPosition';
import type { SftpSide } from '@/stores/sftpStore';

export type SftpBlankContextMenuAction =
  | 'newFile'
  | 'newFolder'
  | 'uploadFile'
  | 'uploadFolder'
  | 'paste'
  | 'copyCurrentDirectoryPath'
  | 'batchMode'
  | 'refresh'
  | 'bookmark';

export interface SftpBlankContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  side: SftpSide;
  local?: boolean;
  currentPath?: string;
  hasClipboard: boolean;
  isBookmarked: boolean;
  batchMode: boolean;
  onClose: () => void;
  onAction: (action: SftpBlankContextMenuAction) => void;
}

interface MenuItemProps {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}

const MenuItem: React.FC<MenuItemProps> = ({ onClick, disabled, icon, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={cn(
      'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
      disabled
        ? 'pointer-events-none text-app-text-soft opacity-40'
        : 'text-app-text hover:bg-app-primary/10 hover:text-app-primary',
    )}
  >
    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
      {icon}
    </span>
    <span className="leading-4">{children}</span>
  </button>
);

export const SftpBlankContextMenu: React.FC<SftpBlankContextMenuProps> = ({
  open,
  x,
  y,
  side,
  local,
  currentPath,
  hasClipboard,
  isBookmarked,
  batchMode,
  onClose,
  onAction,
}) => {
  const { t } = useI18n();
  const { menuRef, position } =
    useViewportConstrainedPosition<HTMLDivElement>(open, x, y);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    const handlePointerDown = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [menuRef, open, onClose]);

  if (!open) return null;

  const isLocal = local ?? side === 'local';

  const handleAction = (action: SftpBlankContextMenuAction): void => {
    onAction(action);
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[1700] max-h-[calc(100vh-1rem)] w-56 max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto rounded-lg border border-app-border bg-app-surface p-1 shadow-[var(--shadow-dialog)]"
      style={position}
    >
        {!isLocal && (
          <>
            <MenuItem
              onClick={() => handleAction('newFile')}
              icon={<FilePlusIcon className="h-3.5 w-3.5" />}
            >
              {t('sftp.contextMenu.newFile')}
            </MenuItem>
            <MenuItem
              onClick={() => handleAction('newFolder')}
              icon={<FolderPlusIcon className="h-3.5 w-3.5" />}
            >
              {t('common.newFolder')}
            </MenuItem>
            <MenuItem
              onClick={() => handleAction('uploadFile')}
              icon={<UploadIcon className="h-3.5 w-3.5" />}
            >
              {t('sftp.contextMenu.uploadFile')}
            </MenuItem>
            <MenuItem
              onClick={() => handleAction('uploadFolder')}
              icon={<FolderUpIcon className="h-3.5 w-3.5" />}
            >
              {t('sftp.contextMenu.uploadFolder')}
            </MenuItem>
            <Separator className="my-0.5" />
          </>
        )}
        {!isLocal && (
          <MenuItem
            onClick={() => handleAction('paste')}
            disabled={!hasClipboard}
            icon={<ClipboardPasteIcon className="h-3.5 w-3.5" />}
          >
            {t('sftp.contextMenu.paste')}
          </MenuItem>
        )}
        <MenuItem
          onClick={() => handleAction('copyCurrentDirectoryPath')}
          disabled={!currentPath}
          icon={<CopyIcon className="h-3.5 w-3.5" />}
        >
          {t('sftp.contextMenu.copyCurrentDirectoryPath')}
        </MenuItem>
        <Separator className="my-0.5" />

        <MenuItem
          onClick={() => handleAction('batchMode')}
          icon={<Grid3X3Icon className="h-3.5 w-3.5" />}
        >
          {batchMode ? t('sftp.contextMenu.batch.exit') : t('sftp.contextMenu.batch.enter')}
        </MenuItem>
        <MenuItem
          onClick={() => handleAction('refresh')}
          icon={<RefreshCwIcon className="h-3.5 w-3.5" />}
        >
          {t('common.refresh')}
        </MenuItem>
        {!isLocal && (
          <MenuItem
            onClick={() => handleAction('bookmark')}
            disabled={!currentPath}
            icon={<BookmarkIcon className="h-3.5 w-3.5" />}
          >
            {isBookmarked
              ? t('sftp.contextMenu.bookmark.remove')
              : t('sftp.contextMenu.bookmark.add')}
          </MenuItem>
        )}
    </div>,
    document.body,
  );
};
