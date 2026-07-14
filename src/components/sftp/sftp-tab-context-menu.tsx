import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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
    <span className="text-app-text-soft">{icon}</span>
    <span>{children}</span>
  </button>
);

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
        <MenuItem onClick={handleTogglePin} icon={<PinIcon />}>
          {connection.pinned ? t('sftp.tab.unpin') : t('sftp.tab.pin')}
        </MenuItem>
        <div className="my-1 h-px bg-app-border" />
        <MenuItem onClick={() => setRenameOpen(true)} icon={<PencilIcon />}>
          {t('common.rename')}
        </MenuItem>
        <MenuItem
          onClick={handleDuplicate}
          disabled={!connection.profileId}
          icon={<DuplicateIcon />}
        >
          {t('common.duplicate')}
        </MenuItem>
        <div className="my-1 h-px bg-app-border" />
        <MenuItem onClick={handleClose} icon={<CloseIcon />}>
          {t('common.close')}
        </MenuItem>
        <MenuItem onClick={handleCloseOthers} icon={<CloseOthersIcon />}>
          {t('sftp.tab.closeOthers')}
        </MenuItem>
        <MenuItem onClick={handleCloseToRight} icon={<CloseRightIcon />}>
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
