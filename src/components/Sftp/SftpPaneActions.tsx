import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="h-3.5 w-3.5 text-app-primary"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )}
  </button>
);

const RefreshIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="h-3.5 w-3.5"
  >
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

const ParentIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="h-3.5 w-3.5"
  >
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);

const FilterIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="h-3.5 w-3.5"
  >
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
  </svg>
);

const BatchIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="h-3.5 w-3.5"
  >
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
  </svg>
);

const NewFolderIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="h-3.5 w-3.5"
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <line x1="12" y1="11" x2="12" y2="17" />
    <line x1="9" y1="14" x2="15" y2="14" />
  </svg>
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
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={cn('h-3 w-3 transition-transform', open && 'rotate-180')}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
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
                icon={<RefreshIcon />}
              >
                {t('common.refresh')}
              </MenuItem>
              <MenuItem
                onClick={() => handleAction(onParentDirectory)}
                icon={<ParentIcon />}
              >
                {t('sftp.parentDirectory')}
              </MenuItem>
              {side === 'remote' && onNewFolder && (
                <MenuItem
                  onClick={() => handleAction(onNewFolder)}
                  icon={<NewFolderIcon />}
                >
                  {t('common.newFolder')}
                </MenuItem>
              )}
              <div className="my-1 h-px bg-app-border" />
              <MenuItem
                onClick={() => handleAction(onToggleFilter)}
                icon={<FilterIcon />}
                checked={filterVisible}
              >
                {filterVisible ? t('sftp.hideFilter') : t('sftp.showFilter')}
              </MenuItem>
              <MenuItem
                onClick={() => handleAction(onToggleBatchMode)}
                icon={<BatchIcon />}
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
