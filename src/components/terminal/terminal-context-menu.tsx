import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/hooks/useI18n';
import { useTerminalStore } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';
import { useConnectSession } from '@/hooks/useConnectSession';
import { invokeCloseSession } from '@/lib/tauri';
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
import { CompactPromptDialog } from '@/components/ui/compact-dialog';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { TerminalSession } from '@/stores/terminalStore';
import type { TerminalSplitDirection } from './terminal-split';

const MENU_WIDTH = 256;
const MENU_HEIGHT = 420;

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

interface MenuItemProps {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}

const MenuItem: React.FC<MenuItemProps> = ({ onClick, disabled, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs text-app-text transition-colors hover:bg-app-primary/10 hover:text-app-primary disabled:pointer-events-none disabled:opacity-40"
  >
    <span className="leading-4">{children}</span>
  </button>
);

export interface TerminalContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  session: TerminalSession | null;
  onClose: () => void;
  canSplit?: boolean;
  isSplit?: boolean;
  onSplit?: (sessionId: string, direction: TerminalSplitDirection) => void;
  onUnsplit?: () => void;
}

export const TerminalContextMenu: React.FC<TerminalContextMenuProps> = ({
  open,
  x,
  y,
  session,
  onClose,
  canSplit = false,
  isSplit = false,
  onSplit,
  onUnsplit,
}) => {
  const { t } = useI18n();
  const sessions = useTerminalStore((state) => state.sessions);
  const removeSession = useTerminalStore((state) => state.removeSession);
  const updateTitle = useTerminalStore((state) => state.updateTitle);
  const togglePin = useTerminalStore((state) => state.togglePin);
  const setTabColor = useTerminalStore((state) => state.setTabColor);
  const getProfile = useProfileStore((state) => state.getProfile);
  const { connect } = useConnectSession();
  const [renameTarget, setRenameTarget] = useState<TerminalSession | null>(null);
  const [confirmationTarget, setConfirmationTarget] = useState<TerminalSession | null>(null);
  const [closeOthersConfirm, setCloseOthersConfirm] = useState(false);
  const [closeToRightConfirm, setCloseToRightConfirm] = useState(false);

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

  const target = session ?? renameTarget ?? confirmationTarget;
  if (!target) return null;

  const left = Math.max(0, Math.min(x, window.innerWidth - MENU_WIDTH));
  const top = Math.max(0, Math.min(y, window.innerHeight - MENU_HEIGHT));

  const closeOthersCount = sessions.filter(
    (s) => s.sessionId !== target.sessionId && !s.pinned,
  ).length;

  const closeToRightCount = (() => {
    const idx = sessions.findIndex((s) => s.sessionId === target.sessionId);
    if (idx === -1) return 0;
    return sessions.slice(idx + 1).filter((s) => !s.pinned).length;
  })();

  const closeSession = (sessionId: string): void => {
    removeSession(sessionId);
    invokeCloseSession(sessionId).catch(() => {});
  };

  const handleDuplicate = (): void => {
    const profile = target.profileId ? getProfile(target.profileId) : undefined;
    if (profile) {
      void connect(profile, {
        insertAfterId: target.sessionId,
        pinned: target.pinned,
        color: target.color,
      });
    }
    onClose();
  };

  const handleCopyInfo = (): void => {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(
        `${target.username}@${target.host}:${target.port}`,
      );
    }
    onClose();
  };

  const handleClose = (): void => {
    document.dispatchEvent(
      new CustomEvent('termbridge:close-terminal-tab', { detail: { sessionId: target.sessionId } }),
    );
    onClose();
  };

  const handleCloseOthers = (): void => {
    setConfirmationTarget(target);
    onClose();
    setCloseOthersConfirm(true);
  };

  const handleCloseToRight = (): void => {
    setConfirmationTarget(target);
    onClose();
    setCloseToRightConfirm(true);
  };

  const dismissCloseOthersConfirm = (): void => {
    setCloseOthersConfirm(false);
    setConfirmationTarget(null);
  };

  const dismissCloseToRightConfirm = (): void => {
    setCloseToRightConfirm(false);
    setConfirmationTarget(null);
  };

  const confirmCloseOthers = (): void => {
    sessions.forEach((s) => {
      if (s.sessionId !== target.sessionId && !s.pinned) {
        closeSession(s.sessionId);
      }
    });
    dismissCloseOthersConfirm();
  };

  const confirmCloseToRight = (): void => {
    const idx = sessions.findIndex((s) => s.sessionId === target.sessionId);
    if (idx > -1) {
      sessions.slice(idx + 1).forEach((s) => {
        if (!s.pinned) {
          closeSession(s.sessionId);
        }
      });
    }
    dismissCloseToRightConfirm();
  };

  const handleRenameConfirm = (value: string): void => {
    if (!renameTarget) return;
    updateTitle(renameTarget.sessionId, value);
    setRenameTarget(null);
  };

  const handleTogglePin = (): void => {
    togglePin(target.sessionId);
    onClose();
  };

  const handleColor = (color?: string): void => {
    setTabColor(target.sessionId, color);
    onClose();
  };

  const handleSplit = (direction: TerminalSplitDirection): void => {
    onSplit?.(target.sessionId, direction);
    onClose();
  };

  const handleUnsplit = (): void => {
    onUnsplit?.();
    onClose();
  };

  return createPortal(
    <>
      {open && session && (
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
            className="fixed z-[1700] w-fit min-w-52 overflow-hidden rounded-lg border border-app-border bg-app-surface p-1 shadow-[var(--shadow-dialog)]"
            style={{ left, top }}
          >
        <MenuItem onClick={handleTogglePin}>
          {target.pinned ? t('terminal.tab.unpin') : t('terminal.tab.pin')}
        </MenuItem>
        <Separator className="my-0.5" />
        <MenuItem
          onClick={() => {
            setRenameTarget(target);
            onClose();
          }}
        >
          {t('common.rename')}
        </MenuItem>
        <MenuItem
          onClick={handleDuplicate}
          disabled={!target.profileId}
        >
          {t('common.duplicate')}
        </MenuItem>
        <MenuItem onClick={handleCopyInfo}>
          {t('terminal.tab.copyInfo')}
        </MenuItem>
        <Separator className="my-0.5" />
        <MenuItem onClick={() => handleSplit('right')} disabled={!canSplit}>
          {t('terminal.tab.splitRight')}
        </MenuItem>
        <MenuItem onClick={() => handleSplit('bottom')} disabled={!canSplit}>
          {t('terminal.tab.splitDown')}
        </MenuItem>
        {isSplit && (
          <MenuItem onClick={handleUnsplit}>
            {t('terminal.tab.unsplit')}
          </MenuItem>
        )}
        <Separator className="my-0.5" />
        <MenuItem onClick={handleClose}>
          {t('common.close')}
        </MenuItem>
        <MenuItem onClick={handleCloseOthers}>
          {t('terminal.tab.closeOthers')}
        </MenuItem>
        <MenuItem onClick={handleCloseToRight}>
          {t('terminal.tab.closeToRight')}
        </MenuItem>
        <Separator className="my-0.5" />
        <div className="px-2.5 py-1.5">
          <div className="mb-1.5 text-xs text-app-text-soft">{t('terminal.tab.color')}</div>
          <div className="flex flex-nowrap items-center gap-1">
            <button
              type="button"
              onClick={() => handleColor(undefined)}
              className={cn(
                'relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-app-border bg-transparent transition-transform hover:scale-110',
                !target.color && 'ring-1 ring-app-primary ring-offset-1 ring-offset-app-surface',
              )}
              aria-label={t('terminal.tab.clearColor')}
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
                  target.color === color &&
                    'ring-1 ring-app-primary ring-offset-1 ring-offset-app-surface',
                )}
                aria-label={color}
              />
            ))}
          </div>
        </div>
          </div>
        </>
      )}
      <CompactPromptDialog
        open={!!renameTarget}
        onClose={() => setRenameTarget(null)}
        onConfirm={handleRenameConfirm}
        title={t('common.rename')}
        label={t('common.name')}
        confirmText={t('common.save')}
        cancelText={t('common.cancel')}
        defaultValue={renameTarget?.title ?? ''}
      />
      <AlertDialog open={closeOthersConfirm} onOpenChange={(o) => { if (!o) dismissCloseOthersConfirm(); }}>
        <AlertDialogContent className="min-w-0 max-w-sm gap-0 overflow-hidden border-app-border bg-app-surface p-0">
          <AlertDialogHeader className="place-items-start px-4 py-2.5 text-left">
            <AlertDialogTitle className="text-sm leading-5">
              {t('terminal.tab.closeOthersConfirmTitle')}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <div className="min-w-0 max-w-full overflow-hidden px-4 py-3">
            <AlertDialogDescription className="block min-w-0 max-w-full break-all text-left leading-5 text-app-text">
              {t('terminal.tab.closeOthersConfirmMessage', { count: closeOthersCount })}
            </AlertDialogDescription>
          </div>
          <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-app-surface px-4 py-2.5">
            <AlertDialogCancel size="sm">{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" size="sm" onClick={confirmCloseOthers}>
              {t('common.close')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={closeToRightConfirm} onOpenChange={(o) => { if (!o) dismissCloseToRightConfirm(); }}>
        <AlertDialogContent className="min-w-0 max-w-sm gap-0 overflow-hidden border-app-border bg-app-surface p-0">
          <AlertDialogHeader className="place-items-start px-4 py-2.5 text-left">
            <AlertDialogTitle className="text-sm leading-5">
              {t('terminal.tab.closeToRightConfirmTitle')}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <div className="min-w-0 max-w-full overflow-hidden px-4 py-3">
            <AlertDialogDescription className="block min-w-0 max-w-full break-all text-left leading-5 text-app-text">
              {t('terminal.tab.closeToRightConfirmMessage', { count: closeToRightCount })}
            </AlertDialogDescription>
          </div>
          <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-app-surface px-4 py-2.5">
            <AlertDialogCancel size="sm">{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" size="sm" onClick={confirmCloseToRight}>
              {t('common.close')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>,
    document.body,
  );
};
