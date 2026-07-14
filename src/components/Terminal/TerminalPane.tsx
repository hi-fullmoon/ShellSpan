import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/ui/EmptyState';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useActiveController } from '@/components/Terminal/hooks/useActiveController';
import { terminalRegistry } from '@/components/Terminal/registry/terminalRegistry';
import { TerminalPaneContextMenu } from './TerminalPaneContextMenu';
import type { TerminalSession as TerminalSessionState } from '@/stores/terminalStore';
import { useToast } from '@/hooks/useToast';
import { cn } from '@/lib/utils';

export interface TerminalPaneProps {
  activeSession: TerminalSessionState | null;
}

export const TerminalPane: React.FC<TerminalPaneProps> = ({ activeSession }) => {
  const paneRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const { success, error: showError } = useToast();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const activeSessionId = activeSession?.sessionId ?? null;
  const { focus, searchNext, searchPrevious, clearSearch } = useActiveController(paneRef, activeSessionId);

  const controller = activeSessionId === null ? undefined : terminalRegistry.get(activeSessionId);
  const terminal = controller?.terminal ?? null;

  const handleOpenSearch = useCallback((): void => {
    setSearchOpen(true);
  }, []);

  const handleCloseSearch = useCallback((): void => {
    clearSearch();
    setSearchOpen(false);
    setQuery('');
    focus();
  }, [clearSearch, focus]);

  const performSearch = useCallback(
    (direction: 'next' | 'previous', term: string) => {
      if (!term) return;
      const options = { caseSensitive };
      if (direction === 'next') {
        searchNext(term, options);
      } else {
        searchPrevious(term, options);
      }
    },
    [caseSensitive, searchNext, searchPrevious],
  );

  // Global keyboard shortcut to open search from anywhere in the panel.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const isCtrlOrMeta = event.ctrlKey || event.metaKey;
      if (isCtrlOrMeta && event.key === 'f') {
        event.preventDefault();
        handleOpenSearch();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleOpenSearch]);

  // Bind xterm custom key handler for find/escape and pane context menu.
  useEffect(() => {
    if (!terminal) return;

    const disposable = terminal.onSelectionChange(() => {
      const selection = terminal.getSelection();
      if (!selection) return;
      void navigator.clipboard
        .writeText(selection)
        .then(() => success(t('terminal.feedback.copied')))
        .catch(() => showError(t('terminal.feedback.copyFailed')));
    });

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const isCtrlOrMeta = event.ctrlKey || event.metaKey;

      if (isCtrlOrMeta && event.key === 'f') {
        event.preventDefault();
        handleOpenSearch();
        return false;
      }

      if (event.key === 'Escape') {
        if (searchOpen) {
          event.preventDefault();
          handleCloseSearch();
          return false;
        }
      }

      return true;
    });

    const element = terminal.element;
    const handleContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      setContextMenu({ x: event.clientX, y: event.clientY });
    };
    element?.addEventListener('contextmenu', handleContextMenu);

    return () => {
      disposable.dispose();
      element?.removeEventListener('contextmenu', handleContextMenu);
      // Reset key handler to avoid stale closures when session changes.
      terminal.attachCustomKeyEventHandler(() => true);
    };
  }, [terminal, searchOpen, handleOpenSearch, handleCloseSearch, success, showError, t]);

  const handleContextMenuClose = useCallback((): void => {
    setContextMenu(null);
  }, []);

  const handleContextMenuCopyFeedback = useCallback(
    (feedback: 'copied' | 'failed') => {
      if (feedback === 'copied') {
        success(t('terminal.feedback.copied'));
      } else {
        showError(t('terminal.feedback.copyFailed'));
      }
    },
    [success, showError, t],
  );

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      {searchOpen && (
        <div className="flex h-9 items-center gap-2 border-b border-app-border bg-app-surface-muted px-2">
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value) {
                searchNext(e.target.value, { caseSensitive });
              } else {
                clearSearch();
              }
            }}
            placeholder={t('terminal.search.placeholder')}
            className="h-6 flex-1"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                performSearch(e.shiftKey ? 'previous' : 'next', query);
              }
              if (e.key === 'Escape') {
                handleCloseSearch();
              }
            }}
          />
          <Button variant="secondary" size="sm" onClick={() => performSearch('previous', query)} title={t('terminal.search.previous')}>
            ↑
          </Button>
          <Button variant="secondary" size="sm" onClick={() => performSearch('next', query)} title={t('terminal.search.next')}>
            ↓
          </Button>
          <Button
            variant={caseSensitive ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => {
              const next = !caseSensitive;
              setCaseSensitive(next);
              if (query) {
                searchNext(query, { caseSensitive: next });
              }
            }}
            title={t('terminal.search.caseSensitive')}
            className={cn('px-1.5 font-mono text-xs', caseSensitive && 'text-app-primary')}
          >
            Aa
          </Button>
          <Button variant="ghost" size="icon" onClick={handleCloseSearch}>
            ×
          </Button>
        </div>
      )}
      <div className="absolute right-0 top-0 z-10">
        <Button variant="ghost" size="icon" onClick={() => setSearchOpen((prev) => !prev)} title={t('terminal.tab.search')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </Button>
      </div>
      {activeSession?.status === 'connecting' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-app-surface/90">
          <Spinner />
          <span className="text-xs text-app-text-soft">{t('terminal.status.connecting')}...</span>
        </div>
      )}
      <div ref={paneRef} className="h-full w-full p-0" />
      <TerminalPaneContextMenu
        open={!!contextMenu}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        session={activeSession}
        terminal={terminal}
        onClose={handleContextMenuClose}
        onCopyFeedback={handleContextMenuCopyFeedback}
        onFind={handleOpenSearch}
      />
    </div>
  );
};
