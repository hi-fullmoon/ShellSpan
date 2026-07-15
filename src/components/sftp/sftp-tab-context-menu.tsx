import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { PinIcon, PencilIcon, CopyIcon, XIcon, ChevronRightIcon } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/hooks/useI18n';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';
import { PromptDialog } from '@/components/ui/dialog';
import type { ConnectionProfile } from '@/types';
import { useProfileStore } from '@/stores/profileStore';

const MENU_WIDTH = 256;
const MENU_HEIGHT = 320;

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
    <span className="text-muted-foreground">{icon}</span>
    <span>{children}</span>
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

  if (!open || !connection) return null;

  const left = Math.max(0, Math.min(x, window.innerWidth - MENU_WIDTH));
  const top = Math.max(0, Math.min(y, window.innerHeight - MENU_HEIGHT));

  const handleClose = (): void => {
    removeConnection(connection.id);
    onClose();
  };

  const handleCloseOthers = (): void => {
    connections.forEach((conn) => {
      if (conn.id !== connection.id && !conn.pinned) {
        removeConnection(conn.id);
      }
    });
    onClose();
  };

  const handleCloseToRight = (): void => {
    const idx = connections.findIndex((conn) => conn.id === connection.id);
    if (idx === -1) {
      onClose();
      return;
    }
    connections.slice(idx + 1).forEach((conn) => {
      if (!conn.pinned) {
        removeConnection(conn.id);
      }
    });
    onClose();
  };

  const handleRenameConfirm = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed) {
      updateTitle(connection.id, trimmed);
    }
    setRenameOpen(false);
    onClose();
  };

  const handleTogglePin = (): void => {
    togglePin(connection.id);
    onClose();
  };

  const handleDuplicate = (): void => {
    if (!connection.profileId) {
      onClose();
      return;
    }
    const profile = getProfile(connection.profileId) as ConnectionProfile | undefined;
    if (profile) {
      const summary = {
        sessionId: connection.sessionId ?? profile.id,
        title: profile.name,
        host: profile.host,
        port: profile.port,
        username: profile.username,
      };
      addConnection(summary, connection.connection, profile.id);
    }
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
        <MenuItem onClick={handleTogglePin} icon={<PinIcon className="h-3.5 w-3.5" />}>
          {connection.pinned ? t('sftp.tab.unpin') : t('sftp.tab.pin')}
        </MenuItem>
        <Separator className="my-1" />
        <MenuItem onClick={() => setRenameOpen(true)} icon={<PencilIcon className="h-3.5 w-3.5" />}>
          {t('common.rename')}
        </MenuItem>
        <MenuItem
          onClick={handleDuplicate}
          disabled={!connection.profileId}
          icon={<CopyIcon className="h-3.5 w-3.5" />}
        >
          {t('common.duplicate')}
        </MenuItem>
        <Separator className="my-1" />
        <MenuItem onClick={handleClose} icon={<XIcon className="h-3.5 w-3.5" />}>
          {t('common.close')}
        </MenuItem>
        <MenuItem onClick={handleCloseOthers} icon={<XIcon className="h-3.5 w-3.5" />}>
          {t('sftp.tab.closeOthers')}
        </MenuItem>
        <MenuItem onClick={handleCloseToRight} icon={<ChevronRightIcon className="h-3.5 w-3.5" />}>
          {t('sftp.tab.closeToRight')}
        </MenuItem>
      </div>
      <PromptDialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        onConfirm={handleRenameConfirm}
        title={t('common.rename')}
        label={t('common.name')}
        confirmText={t('common.save')}
        cancelText={t('common.cancel')}
        defaultValue={connection.title}
      />
    </>,
    document.body,
  );
};
