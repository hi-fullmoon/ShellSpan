import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  ExternalLinkIcon,
  PencilIcon,
  LockIcon,
  Trash2Icon,
  FilePlusIcon,
  FolderPlusIcon,
  UploadIcon,
  FolderUpIcon,
  FileTextIcon,
  EyeIcon,
  DownloadIcon,
  Grid3X3Icon,
  CopyIcon,
  ClipboardPasteIcon,
  TextIcon,
  LinkIcon,
  FolderIcon,
  RefreshCwIcon,
  InfoIcon,
  BookmarkIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import { useViewportConstrainedPosition } from '@/hooks/useViewportConstrainedPosition';
import type { SftpSide } from '@/stores/sftpStore';
import type { FileEntry } from './file-entry-formatters';

export type SftpFileContextMenuAction =
  | 'open'
  | 'openWithDefaultEditor'
  | 'preview'
  | 'download'
  | 'batchMode'
  | 'rename'
  | 'copy'
  | 'delete'
  | 'copyName'
  | 'copyPath'
  | 'copyContainingDirectory'
  | 'newFile'
  | 'newFolder'
  | 'uploadFile'
  | 'uploadFolder'
  | 'editPermissions'
  | 'properties'
  | 'bookmark'
  | 'refresh';

export interface SftpFileContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  side: SftpSide;
  currentPath?: string;
  selectedEntries: FileEntry[];
  isBookmarked: boolean;
  batchMode: boolean;
  onClose: () => void;
  onAction: (action: SftpFileContextMenuAction) => void;
}

interface MenuItemProps {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
  danger?: boolean;
}

const MenuItem: React.FC<MenuItemProps> = ({
  onClick,
  disabled,
  icon,
  children,
  danger,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={cn(
      'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-40',
      danger
        ? 'text-app-error hover:bg-app-error/10'
        : 'text-app-text hover:bg-app-primary/10 hover:text-app-primary',
    )}
  >
    <span className="text-muted-foreground">{icon}</span>
    <span>{children}</span>
  </button>
);

export const SftpFileContextMenu: React.FC<SftpFileContextMenuProps> = ({
  open,
  x,
  y,
  side,
  currentPath,
  selectedEntries,
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

  const isLocal = side === 'local';
  const singleSelection = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
  const hasSelection = selectedEntries.length > 0;
  const canOpen = singleSelection?.kind === 'directory';
  const canOpenWithDefaultEditor = !isLocal && singleSelection?.kind === 'file';
  const canPreview = !isLocal && singleSelection?.kind === 'file';
  const canDownload = !isLocal && singleSelection !== undefined;
  const canRename = !isLocal && singleSelection !== undefined;
  const canCopy = !isLocal && singleSelection !== undefined;
  const canDelete = !isLocal && hasSelection;
  const canEditPermissions = !isLocal && singleSelection !== undefined;
  const canProperties = singleSelection !== undefined;
  const canBookmark = !isLocal && singleSelection?.kind === 'directory';
  const canCopyName = singleSelection !== undefined;
  const canCopyPath = singleSelection !== undefined;
  const canCopyContainingDirectory = singleSelection !== undefined;

  const handleAction = (action: SftpFileContextMenuAction): void => {
    onAction(action);
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[1700] max-h-[calc(100vh-1rem)] w-56 max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto rounded-xl border border-app-border bg-app-surface p-1.5 shadow-[var(--shadow-dialog)]"
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
            <Separator className="my-1" />
          </>
        )}

        <MenuItem
          onClick={() => handleAction('open')}
          disabled={!canOpen}
          icon={<ExternalLinkIcon className="h-3.5 w-3.5" />}
        >
          {t('sftp.contextMenu.open')}
        </MenuItem>

        {!isLocal && (
          <MenuItem
            onClick={() => handleAction('download')}
            disabled={!canDownload}
            icon={<DownloadIcon className="h-3.5 w-3.5" />}
          >
            {t('common.download')}
          </MenuItem>
        )}

        {!isLocal && (
          <>
            <MenuItem
              onClick={() => handleAction('openWithDefaultEditor')}
              disabled={!canOpenWithDefaultEditor}
              icon={<FileTextIcon className="h-3.5 w-3.5" />}
            >
              {t('sftp.contextMenu.openWithDefaultEditor')}
            </MenuItem>
            <MenuItem
              onClick={() => handleAction('preview')}
              disabled={!canPreview}
              icon={<EyeIcon className="h-3.5 w-3.5" />}
            >
              {t('sftp.contextMenu.preview')}
            </MenuItem>
          </>
        )}

        <MenuItem
          onClick={() => handleAction('batchMode')}
          icon={<Grid3X3Icon className="h-3.5 w-3.5" />}
        >
          {batchMode ? t('sftp.contextMenu.batch.exit') : t('sftp.contextMenu.batch.enter')}
        </MenuItem>

        <Separator className="my-1" />

        <MenuItem
          onClick={() => handleAction('rename')}
          disabled={!canRename}
          icon={<PencilIcon className="h-3.5 w-3.5" />}
        >
          {t('common.rename')}
        </MenuItem>

        <MenuItem
          onClick={() => handleAction('copy')}
          disabled={!canCopy}
          icon={<CopyIcon className="h-3.5 w-3.5" />}
        >
          {t('sftp.contextMenu.copy')}
        </MenuItem>

        <MenuItem
          onClick={() => handleAction('delete')}
          disabled={!canDelete}
          icon={<Trash2Icon className="h-3.5 w-3.5" />}
          danger
        >
          {t('common.delete')}
        </MenuItem>

        <Separator className="my-1" />

        <MenuItem
          onClick={() => handleAction('copyName')}
          disabled={!canCopyName}
          icon={<TextIcon className="h-3.5 w-3.5" />}
        >
          {t('sftp.contextMenu.copyName')}
        </MenuItem>

        <MenuItem
          onClick={() => handleAction('copyPath')}
          disabled={!canCopyPath}
          icon={<LinkIcon className="h-3.5 w-3.5" />}
        >
          {t('sftp.contextMenu.copyPath')}
        </MenuItem>

        <MenuItem
          onClick={() => handleAction('copyContainingDirectory')}
          disabled={!canCopyContainingDirectory}
          icon={<FolderIcon className="h-3.5 w-3.5" />}
        >
          {t('sftp.contextMenu.copyContainingDirectory')}
        </MenuItem>

        <Separator className="my-1" />

        <MenuItem
          onClick={() => handleAction('refresh')}
          icon={<RefreshCwIcon className="h-3.5 w-3.5" />}
        >
          {t('common.refresh')}
        </MenuItem>

        {!isLocal && (
          <>
            <MenuItem
              onClick={() => handleAction('editPermissions')}
              disabled={!canEditPermissions}
              icon={<LockIcon className="h-3.5 w-3.5" />}
            >
              {t('sftp.contextMenu.editPermissions')}
            </MenuItem>

            <MenuItem
              onClick={() => handleAction('bookmark')}
              disabled={!canBookmark}
              icon={<BookmarkIcon className="h-3.5 w-3.5" />}
            >
              {isBookmarked
                ? t('sftp.contextMenu.bookmark.remove')
                : t('sftp.contextMenu.bookmark.add')}
            </MenuItem>
          </>
        )}

        <MenuItem
          onClick={() => handleAction('properties')}
          disabled={!canProperties}
          icon={<InfoIcon className="h-3.5 w-3.5" />}
        >
          {t('common.properties')}
        </MenuItem>
    </div>,
    document.body,
  );
};
