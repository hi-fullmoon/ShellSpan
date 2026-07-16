import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useActiveController } from '@/components/terminal/hooks/use-active-controller';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { TerminalPaneContextMenu } from './terminal-pane-context-menu';
import type { TerminalSession as TerminalSessionState } from '@/stores/terminalStore';
import { useToast } from '@/hooks/useToast';
import { getPlatform } from '@/lib/platform';
import { cn } from '@/lib/utils';
import { ChevronUpIcon, ChevronDownIcon, XIcon } from 'lucide-react';

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

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;

      const platform = getPlatform();
      const isCopyShortcut =
        (platform === 'macos' && event.metaKey && event.key.toLowerCase() === 'c') ||
        (platform !== 'macos' && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c');

      if (isCopyShortcut) {
        const selection = terminal.getSelection();
        if (selection) {
          event.preventDefault();
          void navigator.clipboard
            .writeText(selection)
            .then(() => success(t('terminal.feedback.copied')))
            .catch(() => showError(t('terminal.feedback.copyFailed')));
          return false;
        }
      }

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
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-app-bg">
      {searchOpen && (
        <div className="absolute right-0 top-0 z-20 flex h-10 w-80 items-center gap-1.5 rounded-bl-md border border-app-border bg-app-surface p-1.5 shadow-md">
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
            className="h-7 flex-1"
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
          <Button variant="secondary" size="icon" className="h-7 w-7 shrink-0" onClick={() => performSearch('previous', query)} title={t('terminal.search.previous')}>
            <ChevronUpIcon className="h-4 w-4" />
          </Button>
          <Button variant="secondary" size="icon" className="h-7 w-7 shrink-0" onClick={() => performSearch('next', query)} title={t('terminal.search.next')}>
            <ChevronDownIcon className="h-4 w-4" />
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
            className={cn('h-7 px-1.5 font-mono text-xs', caseSensitive && 'text-app-primary')}
          >
            Aa
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={handleCloseSearch} title={t('terminal.search.close')}>
            <XIcon className="h-4 w-4" />
          </Button>
        </div>
      )}
      {activeSession?.status === 'connecting' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-app-surface">
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
