import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/hooks/useI18n';
import { useTerminalStore } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';
import { useConnectSession } from '@/hooks/useConnectSession';
import { invokeCloseSession } from '@/lib/tauri';
import { PromptDialog } from '@/components/ui/Dialog';
import { cn } from '@/lib/utils';
import type { TerminalSession } from '@/stores/terminalStore';

const MENU_WIDTH = 256;
const MENU_HEIGHT = 360;

const TAB_COLORS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#84cc16',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#d946ef',
  '#f43f5e',
];

const PinIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3.5 w-3.5"
  >
    <line x1="12" y1="17" x2="12" y2="22" />
    <path d="M5 17h14" />
    <path d="M12 2v10" />
    <path d="M7 2h10" />
  </svg>
);

const PencilIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3.5 w-3.5"
  >
    <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </svg>
);

const DuplicateIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3.5 w-3.5"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const InfoClipboardIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3.5 w-3.5"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

const CloseIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3.5 w-3.5"
  >
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const CloseOthersIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3.5 w-3.5"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <line x1="9" y1="9" x2="15" y2="15" />
    <line x1="15" y1="9" x2="9" y2="15" />
  </svg>
);

const CloseRightIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3.5 w-3.5"
  >
    <path d="M9 18l6-6-6-6" />
    <line x1="15" y1="6" x2="15" y2="18" />
  </svg>
);

const PaletteIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3.5 w-3.5"
  >
    <circle cx="13.5" cy="6.5" r="2.5" />
    <circle cx="17.5" cy="10.5" r="2.5" />
    <circle cx="8.5" cy="7.5" r="2.5" />
    <circle cx="6.5" cy="12.5" r="2.5" />
    <path d="M12 22c4.418 0 8-3.582 8-8 0-4.418-3.582-8-8-8-4.418 0-8 3.582-8 8 0 4.418 3.582 8 8 8z" />
  </svg>
);

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
    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-app-text transition-colors hover:bg-app-primary/10 hover:text-app-primary disabled:pointer-events-none disabled:opacity-40"
  >
    <span className="text-app-text-soft">{icon}</span>
    <span>{children}</span>
  </button>
);

export interface TerminalContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  session: TerminalSession | null;
  onClose: () => void;
}

export const TerminalContextMenu: React.FC<TerminalContextMenuProps> = ({
  open,
  x,
  y,
  session,
  onClose,
}) => {
  const { t } = useI18n();
  const sessions = useTerminalStore((state) => state.sessions);
  const removeSession = useTerminalStore((state) => state.removeSession);
  const updateTitle = useTerminalStore((state) => state.updateTitle);
  const togglePin = useTerminalStore((state) => state.togglePin);
  const setTabColor = useTerminalStore((state) => state.setTabColor);
  const getProfile = useProfileStore((state) => state.getProfile);
  const { connect } = useConnectSession();
  const [renameOpen, setRenameOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open || !session) return null;

  const left = Math.max(0, Math.min(x, window.innerWidth - MENU_WIDTH));
  const top = Math.max(0, Math.min(y, window.innerHeight - MENU_HEIGHT));

  const closeSession = (sessionId: string): void => {
    removeSession(sessionId);
    invokeCloseSession(sessionId).catch(() => {});
  };

  const handleDuplicate = (): void => {
    const profile = session.profileId ? getProfile(session.profileId) : undefined;
    if (profile) {
      void connect(profile);
    }
    onClose();
  };

  const handleCopyInfo = (): void => {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(
        `${session.username}@${session.host}:${session.port}`,
      );
    }
    onClose();
  };

  const handleClose = (): void => {
    closeSession(session.sessionId);
    onClose();
  };

  const handleCloseOthers = (): void => {
    sessions.forEach((s) => {
      if (s.sessionId !== session.sessionId && !s.pinned) {
        closeSession(s.sessionId);
      }
    });
    onClose();
  };

  const handleCloseToRight = (): void => {
    const idx = sessions.findIndex((s) => s.sessionId === session.sessionId);
    if (idx === -1) {
      onClose();
      return;
    }
    sessions.slice(idx + 1).forEach((s) => {
      if (!s.pinned) {
        closeSession(s.sessionId);
      }
    });
    onClose();
  };

  const handleRenameConfirm = (value: string): void => {
    updateTitle(session.sessionId, value);
    setRenameOpen(false);
    onClose();
  };

  const handleTogglePin = (): void => {
    togglePin(session.sessionId);
    onClose();
  };

  const handleColor = (color?: string): void => {
    setTabColor(session.sessionId, color);
    onClose();
  };

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
        className="fixed z-[1700] w-fit min-w-52 overflow-hidden rounded-xl border border-app-border bg-app-surface p-1.5 shadow-[var(--shadow-dialog)]"
        style={{ left, top }}
      >
        <MenuItem onClick={handleTogglePin} icon={<PinIcon />}>
          {session.pinned ? t('terminal.tab.unpin') : t('terminal.tab.pin')}
        </MenuItem>
        <div className="my-1 h-px bg-app-border" />
        <MenuItem onClick={() => setRenameOpen(true)} icon={<PencilIcon />}>
          {t('common.rename')}
        </MenuItem>
        <MenuItem
          onClick={handleDuplicate}
          disabled={!session.profileId}
          icon={<DuplicateIcon />}
        >
          {t('common.duplicate')}
        </MenuItem>
        <MenuItem onClick={handleCopyInfo} icon={<InfoClipboardIcon />}>
          {t('terminal.tab.copyInfo')}
        </MenuItem>
        <div className="my-1 h-px bg-app-border" />
        <MenuItem onClick={handleClose} icon={<CloseIcon />}>
          {t('common.close')}
        </MenuItem>
        <MenuItem onClick={handleCloseOthers} icon={<CloseOthersIcon />}>
          {t('terminal.tab.closeOthers')}
        </MenuItem>
        <MenuItem onClick={handleCloseToRight} icon={<CloseRightIcon />}>
          {t('terminal.tab.closeToRight')}
        </MenuItem>
        <div className="my-1 h-px bg-app-border" />
        <div className="px-3 py-2">
          <div className="mb-1.5 flex items-center gap-2 text-xs text-app-text-soft">
            <PaletteIcon />
            <span>{t('terminal.tab.color')}</span>
          </div>
          <div className="flex flex-nowrap items-center gap-1">
            <button
              type="button"
              onClick={() => handleColor(undefined)}
              className={cn(
                'relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-app-border bg-transparent transition-transform hover:scale-110',
                !session.color && 'ring-1 ring-app-primary ring-offset-1 ring-offset-app-surface',
              )}
              title={t('terminal.tab.clearColor')}
            >
              <span className="absolute block h-px w-2.5 rotate-45 bg-app-text-soft/50" />
            </button>
            {TAB_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                onClick={() => handleColor(color)}
                style={{ backgroundColor: color }}
                className={cn(
                  'h-4 w-4 shrink-0 rounded-full transition-transform hover:scale-110',
                  session.color === color &&
                    'ring-1 ring-app-primary ring-offset-1 ring-offset-app-surface',
                )}
                title={color}
              />
            ))}
          </div>
        </div>
      </div>
      <PromptDialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        onConfirm={handleRenameConfirm}
        title={t('common.rename')}
        label={t('common.name')}
        confirmText={t('common.save')}
        cancelText={t('common.cancel')}
        defaultValue={session.title}
      />
    </>,
    document.body,
  );
};
