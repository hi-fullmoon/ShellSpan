import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLinkIcon, PencilIcon, LockIcon, Trash2Icon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import type { SftpSide } from '@/stores/sftpStore';
import type { FileEntry } from './file-entry-formatters';

export type SftpFileContextMenuAction = 'open' | 'rename' | 'delete' | 'permissions';

export interface SftpFileContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  side: SftpSide;
  selectedEntries: FileEntry[];
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
  selectedEntries,
  onClose,
  onAction,
}) => {
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const singleSelection = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
  const canOpen = singleSelection?.kind === 'directory';
  const canRename = singleSelection !== undefined;
  const canPermissions = side === 'remote' && singleSelection !== undefined;
  const canDelete = selectedEntries.length > 0;

  const handleAction = (action: SftpFileContextMenuAction): void => {
    onAction(action);
    onClose();
  };

  const left = Math.min(x, window.innerWidth - 192);
  const top = Math.min(y, window.innerHeight - 220);

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[1600]"
        role="presentation"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="fixed z-[1700] w-48 overflow-hidden rounded-xl border border-app-border bg-app-surface p-1.5 shadow-[var(--shadow-dialog)]"
        style={{ left, top }}
      >
        <MenuItem
          onClick={() => handleAction('open')}
          disabled={!canOpen}
          icon={<ExternalLinkIcon className="h-3.5 w-3.5" />}
        >
          {t('sftp.contextMenu.open')}
        </MenuItem>
        <MenuItem
          onClick={() => handleAction('rename')}
          disabled={!canRename}
          icon={<PencilIcon className="h-3.5 w-3.5" />}
        >
          {t('common.rename')}
        </MenuItem>
        <MenuItem
          onClick={() => handleAction('permissions')}
          disabled={!canPermissions}
          icon={<LockIcon className="h-3.5 w-3.5" />}
        >
          {t('common.permissions')}
        </MenuItem>
        <Separator className="my-1" />
        <MenuItem
          onClick={() => handleAction('delete')}
          disabled={!canDelete}
          icon={<Trash2Icon className="h-3.5 w-3.5" />}
          danger
        >
          {t('common.delete')}
        </MenuItem>
      </div>
    </>,
    document.body,
  );
};
