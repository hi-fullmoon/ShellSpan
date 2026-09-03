import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';
import { PromptDialog } from './sftp-dialogs';
import type { ConnectionProfile } from '@/types';
import { useProfileStore } from '@/stores/profileStore';
import { countActiveTransfersForOwners, useTransferStore } from '@/stores/transferStore';

const MENU_WIDTH = 256;
const MENU_HEIGHT = 320;

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

export interface SftpTabContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  connection: SftpConnection | null;
  onClose: () => void;
}

export const SftpTabContextMenu: React.FC<SftpTabContextMenuProps> = ({
  open,
  x,
  y,
  connection,
  onClose,
}) => {
  const { t } = useI18n();
  const connections = useSftpStore((state) => state.connections);
  const removeConnection = useSftpStore((state) => state.removeConnection);
  const updateTitle = useSftpStore((state) => state.updateTitle);
  const togglePin = useSftpStore((state) => state.togglePin);
  const addConnection = useSftpStore((state) => state.addConnection);
  const getProfile = useProfileStore((state) => state.getProfile);
  const pathOccupancyRevision = useTransferStore(
    (state) => state.pathOccupancyRevision,
  );
  const transferOperations = useMemo(
    () => useTransferStore.getState().operations,
    [pathOccupancyRevision],
  );
  const [renameTarget, setRenameTarget] = useState<SftpConnection | null>(null);
  const [confirmationTarget, setConfirmationTarget] = useState<SftpConnection | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
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

  const target = connection ?? renameTarget ?? confirmationTarget;
  if (!target) return null;

  const left = Math.max(0, Math.min(x, window.innerWidth - MENU_WIDTH));
  const top = Math.max(0, Math.min(y, window.innerHeight - MENU_HEIGHT));

  const closeOthersCount = connections.filter(
    (c) => c.id !== target.id && !c.pinned,
  ).length;

  const closeToRightCount = (() => {
    const idx = connections.findIndex((c) => c.id === target.id);
    if (idx === -1) return 0;
    return connections.slice(idx + 1).filter((c) => !c.pinned).length;
  })();
  const closeTransferCount = countActiveTransfersForOwners([target.id], transferOperations);
  const closeOthersTransferCount = countActiveTransfersForOwners(
    connections.filter((item) => item.id !== target.id && !item.pinned).map((item) => item.id),
    transferOperations,
  );
  const closeToRightTransferCount = (() => {
    const index = connections.findIndex((item) => item.id === target.id);
    return countActiveTransfersForOwners(
      index < 0
        ? []
        : connections.slice(index + 1).filter((item) => !item.pinned).map((item) => item.id),
      transferOperations,
    );
  })();

  const handleClose = (): void => {
    setConfirmationTarget(target);
    onClose();
    setCloseConfirm(true);
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

  const dismissCloseConfirm = (): void => {
    setCloseConfirm(false);
    setConfirmationTarget(null);
  };

  const dismissCloseOthersConfirm = (): void => {
    setCloseOthersConfirm(false);
    setConfirmationTarget(null);
  };

  const dismissCloseToRightConfirm = (): void => {
    setCloseToRightConfirm(false);
    setConfirmationTarget(null);
  };

  const confirmClose = (): void => {
    removeConnection(target.id);
    dismissCloseConfirm();
  };

  const confirmCloseOthers = (): void => {
    connections.forEach((conn) => {
      if (conn.id !== target.id && !conn.pinned) {
        removeConnection(conn.id);
      }
    });
    dismissCloseOthersConfirm();
  };

  const confirmCloseToRight = (): void => {
    const idx = connections.findIndex((conn) => conn.id === target.id);
    if (idx > -1) {
      connections.slice(idx + 1).forEach((conn) => {
        if (!conn.pinned) {
          removeConnection(conn.id);
        }
      });
    }
    dismissCloseToRightConfirm();
  };

  const handleRenameConfirm = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed) {
      if (renameTarget) updateTitle(renameTarget.id, trimmed);
    }
    setRenameTarget(null);
  };

  const handleTogglePin = (): void => {
    togglePin(target.id);
    onClose();
  };

  const handleDuplicate = (): void => {
    if (!target.profileId) {
      onClose();
      return;
    }
    const profile = getProfile(target.profileId) as ConnectionProfile | undefined;
    if (profile) {
      const summary = {
        sessionId: target.sessionId ?? profile.id,
        title: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
      };
      addConnection(summary, target.connection, profile.id, {
        insertAfterId: target.id,
        pinned: target.pinned,
      });
    }
    onClose();
  };

  return createPortal(
    <>
      {open && connection && (
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
          {target.pinned ? t('sftp.tab.unpin') : t('sftp.tab.pin')}
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
        <MenuItem onClick={handleDuplicate} disabled={!target.profileId}>
          {t('common.duplicate')}
        </MenuItem>
        <Separator className="my-0.5" />
        <MenuItem onClick={handleClose}>
          {t('common.close')}
        </MenuItem>
        <MenuItem onClick={handleCloseOthers}>
          {t('sftp.tab.closeOthers')}
        </MenuItem>
        <MenuItem onClick={handleCloseToRight}>
          {t('sftp.tab.closeToRight')}
        </MenuItem>
          </div>
        </>
      )}
      <PromptDialog
        open={!!renameTarget}
        onClose={() => setRenameTarget(null)}
        onConfirm={handleRenameConfirm}
        title={t('common.rename')}
        label={t('common.name')}
        confirmText={t('common.save')}
        defaultValue={renameTarget?.title ?? ''}
      />
      <ConfirmationDialog
        open={closeConfirm}
        onOpenChange={(nextOpen) => { if (!nextOpen) dismissCloseConfirm(); }}
        title={t('sftp.tab.closeConfirmTitle')}
        description={closeTransferCount > 0
          ? t('sftp.tab.closeTransferWarning', { title: target.title, count: closeTransferCount })
          : t('sftp.tab.closeConfirmMessage', { title: target.title })}
        confirmLabel={t('common.close')}
        confirmVariant="destructive"
        onConfirm={confirmClose}
      />
      <ConfirmationDialog
        open={closeOthersConfirm}
        onOpenChange={(nextOpen) => { if (!nextOpen) dismissCloseOthersConfirm(); }}
        title={t('sftp.tab.closeOthersConfirmTitle')}
        description={closeOthersTransferCount > 0
          ? t('sftp.tab.closeManyTransferWarning', {
              tabs: closeOthersCount,
              count: closeOthersTransferCount,
            })
          : t('sftp.tab.closeOthersConfirmMessage', { count: closeOthersCount })}
        confirmLabel={t('common.close')}
        confirmVariant="destructive"
        onConfirm={confirmCloseOthers}
      />
      <ConfirmationDialog
        open={closeToRightConfirm}
        onOpenChange={(nextOpen) => { if (!nextOpen) dismissCloseToRightConfirm(); }}
        title={t('sftp.tab.closeToRightConfirmTitle')}
        description={closeToRightTransferCount > 0
          ? t('sftp.tab.closeManyTransferWarning', {
              tabs: closeToRightCount,
              count: closeToRightTransferCount,
            })
          : t('sftp.tab.closeToRightConfirmMessage', { count: closeToRightCount })}
        confirmLabel={t('common.close')}
        confirmVariant="destructive"
        onConfirm={confirmCloseToRight}
      />
    </>,
    document.body,
  );
};
