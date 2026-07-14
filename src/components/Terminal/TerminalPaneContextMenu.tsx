import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { useI18n } from '@/hooks/useI18n';
import { invokeWriteSession } from '@/lib/tauri';
import { cn } from '@/lib/utils';
import type { TerminalSession } from '@/stores/terminalStore';
import type { SessionStatus } from '@/types';

const MENU_WIDTH = 184;

const CopyIcon: React.FC = () => (
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

const PasteIcon: React.FC = () => (
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
    <path d="M16 17l-4 4-4-4" />
    <line x1="12" y1="13" x2="12" y2="21" />
  </svg>
);

const SelectAllIcon: React.FC = () => (
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
    <path d="M9 12l2 2 4-4" />
  </svg>
);

const ClearIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3.5 w-3.5"
  >
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

const SearchIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-3.5 w-3.5"
  >
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
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
        className="fixed z-[1700] w-fit min-w-48 overflow-hidden rounded-xl border border-app-border bg-app-surface p-1.5 shadow-[var(--shadow-dialog)]"
        style={{ left, top }}
      >
        <MenuItem onClick={handleCopy} disabled={!hasSelection} icon={<CopyIcon />}>
          {t('terminal.contextMenu.copy')}
        </MenuItem>
        <MenuItem onClick={handlePaste} icon={<PasteIcon />}>
          {t('terminal.contextMenu.paste')}
        </MenuItem>
        <div className="my-1 h-px bg-app-border" />
        <MenuItem onClick={handleSelectAll} icon={<SelectAllIcon />}>
          {t('terminal.contextMenu.selectAll')}
        </MenuItem>
        <MenuItem onClick={handleClear} icon={<ClearIcon />}>
          {t('terminal.contextMenu.clear')}
        </MenuItem>
        <div className="my-1 h-px bg-app-border" />
        <MenuItem onClick={handleFind} icon={<SearchIcon />}>
          {t('terminal.contextMenu.find')}
        </MenuItem>
      </div>
    </>,
    document.body,
  );
};
