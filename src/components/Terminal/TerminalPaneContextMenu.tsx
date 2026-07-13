import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { useI18n } from '@/hooks/useI18n';
import { invokeWriteSession } from '@/lib/tauri';
import { cn } from '@/lib/utils';
import type { TerminalSession } from '@/stores/terminalStore';
import type { SessionStatus } from '@/types';

const MENU_WIDTH = 176;

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
  const top = Math.max(0, Math.min(y, window.innerHeight - 240));

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
        className="fixed z-[1700] w-fit min-w-44 overflow-hidden rounded-lg border border-app-border bg-app-surface py-1 shadow-[var(--shadow-dialog)]"
        style={{ left, top }}
      >
        <button
          type="button"
          disabled={!hasSelection}
          onClick={handleCopy}
          className={cn(
            'flex w-full items-center px-3 py-1.5 text-left text-xs text-app-text hover:bg-app-surface-muted disabled:pointer-events-none disabled:opacity-40',
          )}
        >
          {t('terminal.contextMenu.copy')}
        </button>
        <button
          type="button"
          onClick={handlePaste}
          className="flex w-full items-center px-3 py-1.5 text-left text-xs text-app-text hover:bg-app-surface-muted"
        >
          {t('terminal.contextMenu.paste')}
        </button>
        <div className="my-1 h-px bg-app-border" />
        <button
          type="button"
          onClick={handleSelectAll}
          className="flex w-full items-center px-3 py-1.5 text-left text-xs text-app-text hover:bg-app-surface-muted"
        >
          {t('terminal.contextMenu.selectAll')}
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="flex w-full items-center px-3 py-1.5 text-left text-xs text-app-text hover:bg-app-surface-muted"
        >
          {t('terminal.contextMenu.clear')}
        </button>
        <div className="my-1 h-px bg-app-border" />
        <button
          type="button"
          onClick={handleFind}
          className="flex w-full items-center px-3 py-1.5 text-left text-xs text-app-text hover:bg-app-surface-muted"
        >
          {t('terminal.contextMenu.find')}
        </button>
      </div>
    </>,
    document.body,
  );
};
