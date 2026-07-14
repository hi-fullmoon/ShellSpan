import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import type { SftpSide } from '@/stores/sftpStore';
import type { FileEntry } from './fileEntryFormatters';

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
        : 'text-app-text hover:bg-app-primary/[0.1] hover:text-app-primary',
    )}
  >
    <span className="text-app-text-soft">{icon}</span>
    <span>{children}</span>
  </button>
);

const OpenIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="h-3.5 w-3.5"
  >
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

const RenameIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="h-3.5 w-3.5"
  >
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </svg>
);

const PermissionsIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="h-3.5 w-3.5"
  >
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

const DeleteIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="h-3.5 w-3.5"
  >
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
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
          icon={<OpenIcon />}
        >
          {t('sftp.contextMenu.open')}
        </MenuItem>
        <MenuItem
          onClick={() => handleAction('rename')}
          disabled={!canRename}
          icon={<RenameIcon />}
        >
          {t('common.rename')}
        </MenuItem>
        <MenuItem
          onClick={() => handleAction('permissions')}
          disabled={!canPermissions}
          icon={<PermissionsIcon />}
        >
          {t('common.permissions')}
        </MenuItem>
        <div className="my-1 h-px bg-app-border" />
        <MenuItem
          onClick={() => handleAction('delete')}
          disabled={!canDelete}
          icon={<DeleteIcon />}
          danger
        >
          {t('common.delete')}
        </MenuItem>
      </div>
    </>,
    document.body,
  );
};
