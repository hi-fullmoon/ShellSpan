import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/hooks/useI18n';
import { useTerminalStore } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';
import { useConnectSession } from '@/hooks/useConnectSession';
import { invokeCloseSession } from '@/lib/tauri';
import { PromptDialog } from '@/components/ui/Dialog';
import type { TerminalSession } from '@/stores/terminalStore';

const MENU_WIDTH = 200;
const MENU_HEIGHT = 220;

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
      if (s.sessionId !== session.sessionId) {
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
      closeSession(s.sessionId);
    });
    onClose();
  };

  const handleRenameConfirm = (value: string): void => {
    updateTitle(session.sessionId, value);
    setRenameOpen(false);
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
        className="fixed z-[1700] w-48 overflow-hidden rounded-lg border border-app-border bg-app-surface py-1 shadow-[var(--shadow-dialog)]"
        style={{ left, top }}
      >
        <button
          type="button"
          onClick={() => setRenameOpen(true)}
          className="flex w-full items-center px-3 py-1.5 text-left text-xs text-app-text hover:bg-app-surface-muted disabled:pointer-events-none disabled:opacity-40"
        >
          {t('common.rename')}
        </button>
        <button
          type="button"
          disabled={!session.profileId}
          onClick={handleDuplicate}
          className="flex w-full items-center px-3 py-1.5 text-left text-xs text-app-text hover:bg-app-surface-muted disabled:pointer-events-none disabled:opacity-40"
        >
          {t('common.duplicate')}
        </button>
        <button
          type="button"
          onClick={handleCopyInfo}
          className="flex w-full items-center px-3 py-1.5 text-left text-xs text-app-text hover:bg-app-surface-muted disabled:pointer-events-none disabled:opacity-40"
        >
          {t('terminal.tab.copyInfo')}
        </button>
        <div className="my-1 h-px bg-app-border" />
        <button
          type="button"
          onClick={handleClose}
          className="flex w-full items-center px-3 py-1.5 text-left text-xs text-app-text hover:bg-app-surface-muted disabled:pointer-events-none disabled:opacity-40"
        >
          {t('common.close')}
        </button>
        <button
          type="button"
          onClick={handleCloseOthers}
          className="flex w-full items-center px-3 py-1.5 text-left text-xs text-app-text hover:bg-app-surface-muted disabled:pointer-events-none disabled:opacity-40"
        >
          {t('terminal.tab.closeOthers')}
        </button>
        <button
          type="button"
          onClick={handleCloseToRight}
          className="flex w-full items-center px-3 py-1.5 text-left text-xs text-app-text hover:bg-app-surface-muted disabled:pointer-events-none disabled:opacity-40"
        >
          {t('terminal.tab.closeToRight')}
        </button>
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
