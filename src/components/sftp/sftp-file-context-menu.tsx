import React, { useEffect, useState } from 'react';
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useI18n } from '@/hooks/useI18n';
import { useViewportConstrainedPosition } from '@/hooks/useViewportConstrainedPosition';
import type { SftpSide } from '@/stores/sftpStore';
import type { FileEntry } from './utils';

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
  local?: boolean;
  currentPath?: string;
  selectedEntries: FileEntry[];
  isBookmarked: boolean;
  batchMode: boolean;
  selectionBusy?: boolean;
  onClose: () => void;
  onAction: (action: SftpFileContextMenuAction, targets?: FileEntry[]) => void;
}

interface MenuItemProps {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
  danger?: boolean;
}

const MenuItem: React.FC<MenuItemProps> = ({ onClick, disabled, icon, children, danger }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    disabled={disabled}
    className={cn(
      'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-40',
      danger ? 'text-app-error hover:bg-app-error/10' : 'text-app-text hover:bg-app-primary/10 hover:text-app-primary',
    )}
  >
    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
    <span className="leading-4">{children}</span>
  </button>
);

export const SftpFileContextMenu: React.FC<SftpFileContextMenuProps> = ({
  open,
  x,
  y,
  side,
  local,
  currentPath,
  selectedEntries,
  isBookmarked,
  batchMode,
  selectionBusy = false,
  onClose,
  onAction,
}) => {
  const { t } = useI18n();
  const { menuRef, position } = useViewportConstrainedPosition<HTMLDivElement>(open, x, y);
  const [deleteTargets, setDeleteTargets] = useState<FileEntry[]>([]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    const handlePointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) {
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

  if (!open && deleteTargets.length === 0) return null;

  const isLocal = local ?? side === 'local';
  const singleSelection = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
  const hasSelection = selectedEntries.length > 0;
  const canOpen = singleSelection?.kind === 'directory';
  const canOpenWithDefaultEditor = !isLocal && singleSelection?.kind === 'file';
  const canPreview = singleSelection?.kind === 'file';
  const canDownload = !isLocal && singleSelection !== undefined && !selectionBusy;
  const canRename = singleSelection !== undefined && !selectionBusy;
  const canCopy = isLocal ? hasSelection : singleSelection !== undefined;
  const canDelete = hasSelection && !selectionBusy;
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

  const requestDelete = (): void => {
    setDeleteTargets([...selectedEntries]);
    onClose();
  };

  const confirmDelete = (): void => {
    // Hand the snapshot taken when the dialog opened to the delete action, so
    // a selection change while the dialog was open cannot retarget the delete.
    onAction('delete', deleteTargets);
    setDeleteTargets([]);
  };

  const deleteDescription = deleteTargets.length === 1
    ? t('sftp.deleteConfirm.single', { name: deleteTargets[0].name })
    : t('sftp.deleteConfirm.multiple', { count: deleteTargets.length });

  return createPortal(
    <>
      {open && deleteTargets.length === 0 && (
      <div
        ref={menuRef}
        role="menu"
        className="fixed z-[1700] max-h-[calc(100vh-1rem)] w-56 max-w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto rounded-lg border border-app-border bg-app-surface p-1 shadow-[var(--shadow-dialog)]"
        style={position}
      >
      {!isLocal && (
        <>
          <MenuItem onClick={() => handleAction('newFile')} icon={<FilePlusIcon className="h-3.5 w-3.5" />}>
            {t('sftp.contextMenu.newFile')}
          </MenuItem>
          <MenuItem onClick={() => handleAction('newFolder')} icon={<FolderPlusIcon className="h-3.5 w-3.5" />}>
            {t('common.newFolder')}
          </MenuItem>
          <MenuItem onClick={() => handleAction('uploadFile')} icon={<UploadIcon className="h-3.5 w-3.5" />}>
            {t('sftp.contextMenu.uploadFile')}
          </MenuItem>
          <MenuItem onClick={() => handleAction('uploadFolder')} icon={<FolderUpIcon className="h-3.5 w-3.5" />}>
            {t('sftp.contextMenu.uploadFolder')}
          </MenuItem>
          <Separator className="my-0.5" />
        </>
      )}

      <MenuItem onClick={() => handleAction('open')} disabled={!canOpen} icon={<ExternalLinkIcon className="h-3.5 w-3.5" />}>
        {t('sftp.contextMenu.open')}
      </MenuItem>

      {!isLocal && (
        <MenuItem onClick={() => handleAction('download')} disabled={!canDownload} icon={<DownloadIcon className="h-3.5 w-3.5" />}>
          {t('common.download')}
        </MenuItem>
      )}

      {!isLocal && (
        <MenuItem
          onClick={() => handleAction('openWithDefaultEditor')}
          disabled={!canOpenWithDefaultEditor}
          icon={<FileTextIcon className="h-3.5 w-3.5" />}
        >
          {t('sftp.contextMenu.openWithDefaultEditor')}
        </MenuItem>
      )}

      <MenuItem onClick={() => handleAction('preview')} disabled={!canPreview} icon={<EyeIcon className="h-3.5 w-3.5" />}>
        {t('sftp.contextMenu.preview')}
      </MenuItem>

      <MenuItem onClick={() => handleAction('batchMode')} icon={<Grid3X3Icon className="h-3.5 w-3.5" />}>
        {batchMode ? t('sftp.contextMenu.batch.exit') : t('sftp.contextMenu.batch.enter')}
      </MenuItem>

      <Separator className="my-0.5" />

      <MenuItem onClick={() => handleAction('rename')} disabled={!canRename} icon={<PencilIcon className="h-3.5 w-3.5" />}>
        {t('common.rename')}
      </MenuItem>

      <MenuItem onClick={() => handleAction('copy')} disabled={!canCopy} icon={<CopyIcon className="h-3.5 w-3.5" />}>
        {t('sftp.contextMenu.copy')}
      </MenuItem>

      <MenuItem onClick={requestDelete} disabled={!canDelete} icon={<Trash2Icon className="h-3.5 w-3.5" />} danger>
        {t('common.delete')}
      </MenuItem>

      <Separator className="my-0.5" />

      <MenuItem onClick={() => handleAction('copyName')} disabled={!canCopyName} icon={<TextIcon className="h-3.5 w-3.5" />}>
        {t('sftp.contextMenu.copyName')}
      </MenuItem>

      <MenuItem onClick={() => handleAction('copyPath')} disabled={!canCopyPath} icon={<LinkIcon className="h-3.5 w-3.5" />}>
        {t('sftp.contextMenu.copyPath')}
      </MenuItem>

      <MenuItem
        onClick={() => handleAction('copyContainingDirectory')}
        disabled={!canCopyContainingDirectory}
        icon={<FolderIcon className="h-3.5 w-3.5" />}
      >
        {t('sftp.contextMenu.copyContainingDirectory')}
      </MenuItem>

      <Separator className="my-0.5 scale-y-[-1]" />

      <MenuItem onClick={() => handleAction('refresh')} icon={<RefreshCwIcon className="h-3.5 w-3.5" />}>
        {t('common.refresh')}
      </MenuItem>

      {!isLocal && (
        <>
          <MenuItem onClick={() => handleAction('editPermissions')} disabled={!canEditPermissions} icon={<LockIcon className="h-3.5 w-3.5" />}>
            {t('sftp.contextMenu.editPermissions')}
          </MenuItem>

          <MenuItem onClick={() => handleAction('bookmark')} disabled={!canBookmark} icon={<BookmarkIcon className="h-3.5 w-3.5" />}>
            {isBookmarked ? t('sftp.contextMenu.bookmark.remove') : t('sftp.contextMenu.bookmark.add')}
          </MenuItem>
        </>
      )}

      <MenuItem onClick={() => handleAction('properties')} disabled={!canProperties} icon={<InfoIcon className="h-3.5 w-3.5" />}>
        {t('common.properties')}
      </MenuItem>
      </div>
      )}
      <AlertDialog
        open={deleteTargets.length > 0}
        onOpenChange={(next) => {
          if (!next) setDeleteTargets([]);
        }}
      >
        <AlertDialogContent className="min-w-0 max-w-sm gap-0 overflow-hidden border-app-border bg-app-surface p-0">
          <AlertDialogHeader className="place-items-start px-4 py-3 text-left">
            <AlertDialogTitle className="text-sm leading-5">
              {t('sftp.deleteConfirm.title')}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <div className="min-w-0 max-w-full overflow-hidden px-4 py-3">
            <AlertDialogDescription className="block min-w-0 max-w-full break-all text-left leading-5 text-app-text">
              {deleteDescription}
            </AlertDialogDescription>
          </div>
          <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-app-surface px-4 pb-4 pt-1">
            <AlertDialogCancel size="sm">
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" size="sm" onClick={confirmDelete}>
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>,
    document.body,
  );
};
