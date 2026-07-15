import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  RefreshCwIcon,
  ArrowLeftIcon,
  FilterIcon,
  Grid3X3Icon,
  FolderPlusIcon,
  CheckIcon,
  ChevronDownIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';

export interface SftpPaneActionsProps {
  side: 'local' | 'remote';
  batchMode: boolean;
  filterVisible: boolean;
  onRefresh: () => void;
  onParentDirectory: () => void;
  onToggleFilter: () => void;
  onToggleBatchMode: () => void;
  onNewFolder?: () => void;
}

interface MenuItemProps {
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  checked?: boolean;
}

const MenuItem: React.FC<MenuItemProps> = ({
  onClick,
  icon,
  children,
  checked,
}) => (
  <button
    type="button"
    onClick={onClick}
    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-app-text transition-colors hover:bg-app-primary/[0.1] hover:text-app-primary"
  >
    <span className="text-app-text-soft">{icon}</span>
    <span className="flex-1">{children}</span>
    {checked && (
      <CheckIcon className="h-3.5 w-3.5 text-app-primary" />
    )}
  </button>
);

export const SftpPaneActions: React.FC<SftpPaneActionsProps> = ({
  side,
  batchMode,
  filterVisible,
  onRefresh,
  onParentDirectory,
  onToggleFilter,
  onToggleBatchMode,
  onNewFolder,
}) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  const handleToggle = (): void => setOpen((prev) => !prev);

  const handleAction = (action: () => void): void => {
    action();
    setOpen(false);
  };

  const rect = buttonRef.current?.getBoundingClientRect();

  return (
    <>
      <button
        ref={buttonRef}
        onClick={handleToggle}
        className={cn(
          'inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors',
          open
            ? 'bg-app-primary text-app-primary-text'
            : 'bg-app-surface-muted text-app-text hover:bg-app-border',
        )}
      >
        <span>{t('sftp.actions')}</span>
        <ChevronDownIcon className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-[1400]"
              role="presentation"
              onClick={() => setOpen(false)}
              onContextMenu={(e) => {
                e.preventDefault();
                setOpen(false);
              }}
            />
            <div
              className="fixed z-[1500] w-52 overflow-hidden rounded-xl border border-app-border bg-app-surface p-1.5 shadow-[var(--shadow-dialog)]"
              style={{
                top: rect ? rect.bottom + 4 : 0,
                right: rect
                  ? window.innerWidth - rect.right
                  : undefined,
              }}
            >
              <MenuItem
                onClick={() => handleAction(onRefresh)}
                icon={<RefreshCwIcon className="h-3.5 w-3.5" />}
              >
                {t('common.refresh')}
              </MenuItem>
              <MenuItem
                onClick={() => handleAction(onParentDirectory)}
                icon={<ArrowLeftIcon className="h-3.5 w-3.5" />}
              >
                {t('sftp.parentDirectory')}
              </MenuItem>
              {side === 'remote' && onNewFolder && (
                <MenuItem
                  onClick={() => handleAction(onNewFolder)}
                  icon={<FolderPlusIcon className="h-3.5 w-3.5" />}
                >
                  {t('common.newFolder')}
                </MenuItem>
              )}
              <div className="my-1 h-px bg-app-border" />
              <MenuItem
                onClick={() => handleAction(onToggleFilter)}
                icon={<FilterIcon className="h-3.5 w-3.5" />}
                checked={filterVisible}
              >
                {filterVisible ? t('sftp.hideFilter') : t('sftp.showFilter')}
              </MenuItem>
              <MenuItem
                onClick={() => handleAction(onToggleBatchMode)}
                icon={<Grid3X3Icon className="h-3.5 w-3.5" />}
                checked={batchMode}
              >
                {t('sftp.batchMode')}
              </MenuItem>
            </div>
          </>,
          document.body,
        )}
    </>
  );
};
