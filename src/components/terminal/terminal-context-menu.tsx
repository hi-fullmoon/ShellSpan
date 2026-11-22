import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/hooks/useI18n';
import { useTerminalStore } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';
import { useConnectSession } from '@/hooks/useConnectSession';
import { useReconnectSession } from '@/hooks/useReconnectSession';
import { useCloseTerminal } from '@/hooks/useCloseTerminal';
import { useContextMenuNavigation } from '@/hooks/useContextMenuNavigation';
import { useViewportConstrainedPosition } from '@/hooks/useViewportConstrainedPosition';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { CompactPromptDialog } from '@/components/ui/compact-dialog';
import { Separator } from '@/components/ui/separator';
import { writeClipboardText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import type { TerminalSession } from '@/stores/terminalStore';
import type { TerminalSplitDirection } from './terminal-split';
import { TerminalCloseDetails } from './terminal-close-details';
import { agentTerminalLeaseState } from './agent-terminal-lease-state';
import { useAppStore } from '@/stores/appStore';
import { useFocusStore } from '@/stores/focusStore';
import { useToast } from '@/hooks/useToast';
import { getTerminalMenuDirectory, openTerminalSftpPath, revealTerminalCurrentDirectory } from '@/lib/terminal/terminal-current-directory';

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
  title?: string;
  children: React.ReactNode;
}

const MenuItem: React.FC<MenuItemProps> = ({ onClick, disabled, title, children }) => (
  <button
    type="button"
    role="menuitem"
    tabIndex={-1}
    onClick={onClick}
    disabled={disabled}
    title={title}
    className="flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-xs text-app-text transition-colors focus:bg-accent focus:text-app-primary focus-visible:outline-hidden! disabled:pointer-events-none disabled:opacity-40"
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
  canSplitDirection?: (direction: TerminalSplitDirection) => boolean;
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
  canSplitDirection,
  isSplit = false,
  onSplit,
  onUnsplit,
}) => {
  const { t } = useI18n();
  const { error: showError } = useToast();
  const focus = useFocusStore();
  const sessions = useTerminalStore((state) => state.sessions);
  const closeTerminal = useCloseTerminal();
  const updateTitle = useTerminalStore((state) => state.updateTitle);
  const togglePin = useTerminalStore((state) => state.togglePin);
  const setTabColor = useTerminalStore((state) => state.setTabColor);
  const getProfile = useProfileStore((state) => state.getProfile);
  const { connect } = useConnectSession();
  const reconnect = useReconnectSession();
  const [renameTarget, setRenameTarget] = useState<TerminalSession | null>(null);
  const [reconnectConfirmTarget, setReconnectConfirmTarget] = useState<TerminalSession | null>(null);
  const [confirmationTarget, setConfirmationTarget] = useState<TerminalSession | null>(null);
  const [confirmationOrder, setConfirmationOrder] = useState<string[] | null>(null);
  const [closeOthersConfirm, setCloseOthersConfirm] = useState(false);
  const [closeToRightConfirm, setCloseToRightConfirm] = useState(false);
  const isMenuVisible = open && session !== null;
  const { menuRef, position } = useViewportConstrainedPosition<HTMLDivElement>(isMenuVisible, x, y);
  const navigation = useContextMenuNavigation(menuRef, isMenuVisible, session?.sessionId);

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

  const target = session ?? renameTarget ?? confirmationTarget ?? reconnectConfirmTarget;
  if (!target) return null;

  const liveSession = sessions.find((s) => s.sessionId === target.sessionId) ?? target;
  const canReconnect = !liveSession.reconnecting
    && !liveSession.pendingConnection
    && liveSession.status !== 'connecting'
    && (!liveSession.profileId || Boolean(getProfile(liveSession.profileId)));

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
    void closeTerminal(sessionId);
  };

  const handleReconnect = (): void => {
    onClose();
    if (agentTerminalLeaseState.get(target.sessionId)) {
      setReconnectConfirmTarget(target);
      return;
    }
    void reconnect(target.sessionId, false, { resetBuffer: true });
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
    void writeClipboardText(`${target.username}@${target.host}:${target.port}`)
      .catch(() => showError(t('terminal.feedback.copyFailed')));
    onClose();
  };

  const handleOpenSftp = (): void => {
    onClose();
    if (!target.profileId) return;
    const openDefault = (profileId: string) => document.dispatchEvent(new CustomEvent('shellspan:connect-profile', {
      detail: { profileId, target: 'sftp' },
    }));
    const current = useTerminalStore.getState().sessions.find((session) => session.sessionId === target.sessionId);
    if (current?.status !== 'connected') {
      openDefault(target.profileId);
      return;
    }
    void getTerminalMenuDirectory(target.sessionId).then((directory) => {
      const current = useTerminalStore.getState().sessions.find((session) => session.sessionId === target.sessionId);
      if (!current?.profileId) return;
      if (directory && openTerminalSftpPath(current, directory)) return;
      openDefault(current.profileId);
    });
  };

  const handleClose = (): void => {
    document.dispatchEvent(
      new CustomEvent('shellspan:close-terminal-tab', { detail: { sessionId: target.sessionId } }),
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
            className="fixed z-[1700] max-h-[calc(100vh-1rem)] w-fit min-w-52 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-app-border bg-app-surface p-1 shadow-[var(--shadow-dialog)]"
            style={position}
            {...navigation}
          >
        {focus.enabled && <>
          <MenuItem disabled={focus.busy || focus.targetSessionId === target.sessionId
            || sessions.find(s => s.sessionId === target.sessionId)?.status !== 'connected'}
            title={focus.busy ? t('focus.targetLocked') : undefined}
            onClick={() => { if (focus.setTarget(target.sessionId)) onClose(); }}>
            {focus.targetSessionId === target.sessionId ? t('focus.agentTarget') : t('focus.setTarget')}
          </MenuItem>
          <Separator className="my-0.5" />
        </>}
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
        <MenuItem disabled={!target.manualTitle} onClick={() => {
          useTerminalStore.getState().resetTitle(target.sessionId);
          onClose();
        }}>{t('terminal.title.reset')}</MenuItem>
        <MenuItem onClick={() => {
          useAppStore.getState().openSettings('terminal', 'terminal-title-template');
          onClose();
        }}>{t('terminal.title.template')}</MenuItem>
        <MenuItem
          onClick={handleReconnect}
          disabled={!canReconnect}
        >
          {t('terminal.menu.reconnect')}
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
        {target.host === 'local' && target.port === 0 && (
          <MenuItem disabled={target.status !== 'connected'} onClick={() => {
            onClose();
            void revealTerminalCurrentDirectory(target.sessionId).then((opened) => {
              if (!opened) showError(t('terminal.menu.noCurrentDirectory'));
            }).catch(() => showError(t('ai.path.revealFailed')));
          }}>
            {t('terminal.menu.revealCurrentDirectory')}
          </MenuItem>
        )}
        <MenuItem onClick={() => {
          useTerminalStore.getState().toggleReadOnly(target.sessionId);
          onClose();
        }}>
          {t(sessions.find((session) => session.sessionId === target.sessionId)?.readOnly
            ? 'terminal.inputLock.unlock' : 'terminal.inputLock.lock')}
        </MenuItem>
        <Separator className="my-0.5" />
        <MenuItem onClick={() => handleSplit('right')} disabled={!canSplit || canSplitDirection?.('right') === false}>
          {t('terminal.tab.splitRight')}
        </MenuItem>
        <MenuItem onClick={() => handleSplit('bottom')} disabled={!canSplit || canSplitDirection?.('bottom') === false}>
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
      <ConfirmationDialog
        open={!!reconnectConfirmTarget}
        onOpenChange={(nextOpen) => { if (!nextOpen) setReconnectConfirmTarget(null); }}
        title={t('terminal.menu.reconnectConfirmTitle')}
        description={t('terminal.menu.reconnectConfirmDescription')}
        confirmLabel={t('terminal.menu.reconnect')}
        confirmVariant="destructive"
        onConfirm={() => {
          const confirmed = reconnectConfirmTarget;
          setReconnectConfirmTarget(null);
          if (confirmed) void reconnect(confirmed.sessionId, false, { resetBuffer: true });
        }}
      />
      <ConfirmationDialog
        open={closeOthersConfirm}
        contentClassName="[&>[data-slot=scroll-area]]:max-h-[min(280px,calc(100vh-12rem))]"
        onOpenChange={(nextOpen) => { if (!nextOpen) dismissCloseOthersConfirm(); }}
        title={t('terminal.tab.closeOthersConfirmTitle')}
        description={t('terminal.tab.closeOthersConfirmMessage', { count: closeOthersIds.length })}
        confirmLabel={t('common.close')}
        confirmVariant="destructive"
        onConfirm={confirmCloseOthers}
      >
        <TerminalCloseDetails sessions={closeOthersIds.flatMap((id) => sessions.filter((item) => item.sessionId === id))} />
      </ConfirmationDialog>
      <ConfirmationDialog
        open={closeToRightConfirm}
        onOpenChange={(nextOpen) => { if (!nextOpen) dismissCloseToRightConfirm(); }}
        title={t('terminal.tab.closeToRightConfirmTitle')}
        description={t('terminal.tab.closeToRightConfirmMessage', { count: closeToRightIds.length })}
        confirmLabel={t('common.close')}
        confirmVariant="destructive"
        onConfirm={confirmCloseToRight}
      >
        <TerminalCloseDetails sessions={closeToRightIds.flatMap((id) => sessions.filter((item) => item.sessionId === id))} />
      </ConfirmationDialog>
    </>,
    document.body,
  );
};
