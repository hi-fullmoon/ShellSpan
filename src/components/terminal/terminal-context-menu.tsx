import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/hooks/useI18n';
import { useTerminalStore } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';
import { useConnectSession } from '@/hooks/useConnectSession';
import { invokeCloseSession } from '@/lib/tauri';
import { PromptDialog } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { PinIcon, PencilIcon, CopyIcon, InfoIcon, XIcon, ChevronRightIcon, PaletteIcon } from 'lucide-react';
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

// Icons replaced with lucide-react imports

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
    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-app-text transition-colors hover:bg-app-surface-muted disabled:pointer-events-none disabled:opacity-40"
  >
    <span>{icon}</span>
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
        <Separator className="my-1" />
        <MenuItem onClick={() => setRenameOpen(true)} icon={<PencilIcon />}>
          {t('common.rename')}
        </MenuItem>
        <MenuItem
          onClick={handleDuplicate}
          disabled={!session.profileId}
          icon={<CopyIcon />}
        >
          {t('common.duplicate')}
        </MenuItem>
        <MenuItem onClick={handleCopyInfo} icon={<InfoIcon />}>
          {t('terminal.tab.copyInfo')}
        </MenuItem>
        <Separator className="my-1" />
        <MenuItem onClick={handleClose} icon={<XIcon />}>
          {t('common.close')}
        </MenuItem>
        <MenuItem onClick={handleCloseOthers} icon={<XIcon />}>
          {t('terminal.tab.closeOthers')}
        </MenuItem>
        <MenuItem onClick={handleCloseToRight} icon={<ChevronRightIcon />}>
          {t('terminal.tab.closeToRight')}
        </MenuItem>
        <Separator className="my-1" />
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
