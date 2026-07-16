import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { useI18n } from '@/hooks/useI18n';
import { invokeWriteSession } from '@/lib/tauri';
import { Separator } from '@/components/ui/separator';
import type { TerminalSession } from '@/stores/terminalStore';
import type { SessionStatus } from '@/types';

const MENU_WIDTH = 184;

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

interface TerminalPaneContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  session: TerminalSession | null;
  terminal: Terminal | null;
  onClose: () => void;
  onCopyFeedback: (feedback: 'copied' | 'failed') => void;
  onFind: () => void;
}

function writeToTerminal(
  status: SessionStatus,
  sessionId: string,
  terminal: Terminal | null,
  data: string,
): void {
  if (!terminal) {
    return;
  }
  if (status === 'connected') {
    void invokeWriteSession(sessionId, data).catch(() => {});
  } else {
    terminal.write(data);
  }
}

export const TerminalPaneContextMenu: React.FC<TerminalPaneContextMenuProps> = ({
  open,
  x,
  y,
  session,
  terminal,
  onClose,
  onCopyFeedback,
  onFind,
}) => {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const [hasSelection, setHasSelection] = useState(false);

  useEffect(() => {
    if (!open) return;
    setHasSelection(!!terminal?.getSelection());

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, terminal, onClose]);

  if (!open || !session) return null;

  const left = Math.max(0, Math.min(x, window.innerWidth - MENU_WIDTH));
  const top = Math.max(0, Math.min(y, window.innerHeight - 260));

  const handleCopy = async (): Promise<void> => {
    if (!terminal) return;
    const selection = terminal.getSelection();
    if (!selection) return;
    try {
      await navigator.clipboard.writeText(selection);
      onCopyFeedback('copied');
    } catch {
      onCopyFeedback('failed');
    }
    onClose();
  };

  const handlePaste = async (): Promise<void> => {
    if (!terminal) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      writeToTerminal(session.status, session.sessionId, terminal, text);
    } catch {
      onCopyFeedback('failed');
    }
    onClose();
  };

  const handleSelectAll = (): void => {
    terminal?.selectAll();
    onClose();
  };

  const handleClear = (): void => {
    terminal?.clear();
    onClose();
  };

  const handleFind = (): void => {
    onFind();
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
        ref={menuRef}
        className="fixed z-[1700] w-fit min-w-48 overflow-hidden rounded-lg border border-app-border bg-app-surface p-1 shadow-[var(--shadow-dialog)]"
        style={{ left, top }}
      >
        <MenuItem onClick={handleCopy} disabled={!hasSelection}>
          {t('terminal.contextMenu.copy')}
        </MenuItem>
        <MenuItem onClick={handlePaste}>
          {t('terminal.contextMenu.paste')}
        </MenuItem>
        <Separator className="my-0.5" />
        <MenuItem onClick={handleSelectAll}>
          {t('terminal.contextMenu.selectAll')}
        </MenuItem>
        <MenuItem onClick={handleClear}>
          {t('terminal.contextMenu.clear')}
        </MenuItem>
        <Separator className="my-0.5" />
        <MenuItem onClick={handleFind}>
          {t('terminal.contextMenu.find')}
        </MenuItem>
      </div>
    </>,
    document.body,
  );
};
