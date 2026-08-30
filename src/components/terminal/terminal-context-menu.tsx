import React, { useEffect, useRef, useState } from 'react';
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
import { archiveTerminalAiSession } from '@/lib/ai-sessions';
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
    role="menuitem"
    tabIndex={-1}
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
  /**
   * Tab order of the tab bar this menu was opened from. When split, this is the
   * source group's sessionIds so positional actions (close others / close to
   * the right) only affect tabs the user actually sees in that group. Defaults
   * to the global sessions order.
   */
  orderedSessionIds?: string[];
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
  orderedSessionIds,
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
  const [confirmationOrder, setConfirmationOrder] = useState<string[] | null>(null);
  const [closeOthersConfirm, setCloseOthersConfirm] = useState(false);
  const [closeToRightConfirm, setCloseToRightConfirm] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!open || !session) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frameId = window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')
        ?.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [open, session?.sessionId]);

  const target = session ?? renameTarget ?? confirmationTarget;
  if (!target) return null;

  const left = Math.max(0, Math.min(x, window.innerWidth - MENU_WIDTH));
  const top = Math.max(0, Math.min(y, window.innerHeight - MENU_HEIGHT));

  const orderedIds = confirmationOrder ?? orderedSessionIds ?? sessions.map((s) => s.sessionId);
  const isUnpinned = (sessionId: string): boolean =>
    !sessions.find((s) => s.sessionId === sessionId)?.pinned;

  const closeOthersIds = orderedIds.filter(
    (id) => id !== target.sessionId && isUnpinned(id),
  );

  const closeToRightIds = (() => {
    const idx = orderedIds.indexOf(target.sessionId);
    if (idx === -1) return [];
    return orderedIds.slice(idx + 1).filter(isUnpinned);
  })();

  const closeSession = (sessionId: string): void => {
    archiveTerminalAiSession(sessionId);
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

  const handleOpenSftp = (): void => {
    if (target.profileId) {
      document.dispatchEvent(new CustomEvent('termbridge:connect-profile', {
        detail: { profileId: target.profileId, target: 'sftp' },
      }));
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
    setConfirmationOrder([...orderedIds]);
    onClose();
    setCloseOthersConfirm(true);
  };

  const handleCloseToRight = (): void => {
    setConfirmationTarget(target);
    setConfirmationOrder([...orderedIds]);
    onClose();
    setCloseToRightConfirm(true);
  };

  const dismissCloseOthersConfirm = (): void => {
    setCloseOthersConfirm(false);
    setConfirmationTarget(null);
    setConfirmationOrder(null);
  };

  const dismissCloseToRightConfirm = (): void => {
    setCloseToRightConfirm(false);
    setConfirmationTarget(null);
    setConfirmationOrder(null);
  };

  const confirmCloseOthers = (): void => {
    closeOthersIds.forEach(closeSession);
    dismissCloseOthersConfirm();
  };

  const confirmCloseToRight = (): void => {
    closeToRightIds.forEach(closeSession);
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

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])',
      ) ?? [],
    );
    if (items.length === 0) return;

    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    let nextIndex: number;
    if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = items.length - 1;
    } else if (event.key === 'ArrowUp') {
      nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
    } else {
      nextIndex = currentIndex < 0 || currentIndex === items.length - 1
        ? 0
        : currentIndex + 1;
    }
    items[nextIndex]?.focus({ preventScroll: true });
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
            ref={menuRef}
            role="menu"
            aria-label={target.title}
            className="fixed z-[1700] w-fit min-w-52 overflow-hidden rounded-lg border border-app-border bg-app-surface p-1 shadow-[var(--shadow-dialog)]"
            style={{ left, top }}
            onKeyDown={handleMenuKeyDown}
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
        <MenuItem onClick={handleOpenSftp} disabled={!target.profileId}>
          {t('terminal.tab.openSftp')}
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
              role="menuitemradio"
              aria-checked={!target.color}
              tabIndex={-1}
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
                role="menuitemradio"
                aria-checked={target.color === color}
                tabIndex={-1}
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
          <AlertDialogHeader className="place-items-start px-4 py-3 text-left">
            <AlertDialogTitle className="text-sm leading-5">
              {t('terminal.tab.closeOthersConfirmTitle')}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <div className="min-w-0 max-w-full overflow-hidden px-4 py-3">
            <AlertDialogDescription className="block min-w-0 max-w-full break-all text-left leading-5 text-app-text">
              {t('terminal.tab.closeOthersConfirmMessage', { count: closeOthersIds.length })}
            </AlertDialogDescription>
          </div>
          <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-app-surface px-4 pb-4 pt-1">
            <AlertDialogCancel size="sm">{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" size="sm" onClick={confirmCloseOthers}>
              {t('common.close')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={closeToRightConfirm} onOpenChange={(o) => { if (!o) dismissCloseToRightConfirm(); }}>
        <AlertDialogContent className="min-w-0 max-w-sm gap-0 overflow-hidden border-app-border bg-app-surface p-0">
          <AlertDialogHeader className="place-items-start px-4 py-3 text-left">
            <AlertDialogTitle className="text-sm leading-5">
              {t('terminal.tab.closeToRightConfirmTitle')}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <div className="min-w-0 max-w-full overflow-hidden px-4 py-3">
            <AlertDialogDescription className="block min-w-0 max-w-full break-all text-left leading-5 text-app-text">
              {t('terminal.tab.closeToRightConfirmMessage', { count: closeToRightIds.length })}
            </AlertDialogDescription>
          </div>
          <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-app-surface px-4 pb-4 pt-1">
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
