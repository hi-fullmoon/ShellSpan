import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { useActiveController } from '@/components/terminal/hooks/use-active-controller';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { handleTerminalLeaderKeydown } from '@/components/terminal/terminal-leader';
import type { TerminalSession as TerminalSessionState } from '@/stores/terminalStore';
import { useToast } from '@/hooks/useToast';
import { getPlatform } from '@/lib/platform';
import { eventMatchesShortcut } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import type { ShortcutBindings } from '@/types';
import { ChevronUpIcon, ChevronDownIcon, XIcon } from 'lucide-react';

const effectiveShortcuts = (): ShortcutBindings => ({
  ...DEFAULT_SHORTCUTS,
  ...useAppStore.getState().shortcuts,
});

const ReconnectingIndicator: React.FC<{ label: string }> = ({ label }) => (
  <div
    className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
    role="status"
    aria-label={label}
  >
    <span className="rounded-sm bg-app-surface/90 px-3 py-1.5 font-mono text-sm text-app-text-soft shadow-sm">
      <span aria-hidden="true">
        {label}
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="inline-block animate-pulse"
            style={{ animationDelay: `${index * 200}ms` }}
          >
            .
          </span>
        ))}
      </span>
    </span>
  </div>
);

export interface TerminalPaneProps {
  activeSession: TerminalSessionState | null;
  isActive?: boolean;
}

export const TerminalPane: React.FC<TerminalPaneProps> = ({ activeSession, isActive = true }) => {
  const paneRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const { success, error: showError } = useToast();
  const copyOnSelect = useAppStore((state) => state.terminalCopyOnSelect);
  const multiLinePasteWarning = useAppStore((state) => state.terminalMultiLinePasteWarning);
  const largePasteWarning = useAppStore((state) => state.terminalLargePasteWarning);
  const trimTrailingWhitespace = useAppStore((state) => state.terminalTrimTrailingWhitespace);
  const rightClickBehavior = useAppStore((state) => state.terminalRightClickBehavior);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [pendingPaste, setPendingPaste] = useState('');
  const activeSessionId = activeSession?.sessionId ?? null;
  const { focus, searchNext, searchPrevious, clearSearch } = useActiveController(
    paneRef,
    activeSessionId,
    isActive,
  );

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

  useEffect(() => {
    if (!isActive) return;
    const handleOpenSearchRequest = (): void => handleOpenSearch();
    document.addEventListener('termbridge:find-terminal', handleOpenSearchRequest);
    return () => document.removeEventListener('termbridge:find-terminal', handleOpenSearchRequest);
  }, [handleOpenSearch, isActive]);

  // Bind xterm custom key handler for find/escape and copy.
  useEffect(() => {
    if (!terminal) return;

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;

      // Leader-key chords (default Ctrl+B then a command key) are resolved
      // before anything else and never reach the pty.
      if (handleTerminalLeaderKeydown(event)) {
        event.preventDefault();
        event.stopPropagation();
        return false;
      }

      const platform = getPlatform();
      const isCopyShortcut =
        (platform === 'macos' && event.metaKey && event.key.toLowerCase() === 'c') ||
        (platform !== 'macos' && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c');

      // Find follows the configurable binding so it cannot diverge from the
      // app-level shortcut map. Copy stays hardcoded: it mirrors the OS
      // clipboard convention whose default differs per platform.
      const isFindShortcut = eventMatchesShortcut(event, effectiveShortcuts().findTerminal);

      if (isFindShortcut) {
        event.preventDefault();
        event.stopPropagation();
        handleOpenSearch();
        return false;
      }

      if (isCopyShortcut) {
        const selection = terminal.getSelection();
        if (selection) {
          event.preventDefault();
          const copiedText = trimTrailingWhitespace
            ? selection.replace(/[ \t]+(?=\r?$)/gm, '')
            : selection;
          void navigator.clipboard
            .writeText(copiedText)
            .then(() => success(t('terminal.feedback.copied')))
            .catch(() => showError(t('terminal.feedback.copyFailed')));
          return false;
        }
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

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (!copyOnSelect) return;
      const selection = terminal.getSelection();
      if (!selection) return;
      const copiedText = trimTrailingWhitespace
        ? selection.replace(/[ \t]+(?=\r?$)/gm, '')
        : selection;
      void navigator.clipboard
        .writeText(copiedText)
        .catch(() => showError(t('terminal.feedback.copyFailed')));
    });

    const element = terminal.element;
    const pasteText = (text: string): void => {
      const isMultiLine = /[\r\n]/.test(text);
      const isLarge = new Blob([text]).size > 5 * 1024;
      if ((multiLinePasteWarning && isMultiLine) || (largePasteWarning && isLarge)) {
        setPendingPaste(text);
        return;
      }
      terminal.paste(text);
    };
    const handleContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      if (activeSession?.status !== 'connected') return;

      if (rightClickBehavior === 'none') return;
      if (rightClickBehavior === 'copyPaste') {
        const selection = terminal.getSelection();
        if (selection) {
          const copiedText = trimTrailingWhitespace
            ? selection.replace(/[ \t]+(?=\r?$)/gm, '')
            : selection;
          void navigator.clipboard
            .writeText(copiedText)
            .then(() => success(t('terminal.feedback.copied')))
            .catch(() => showError(t('terminal.feedback.copyFailed')));
          return;
        }
      }

      void navigator.clipboard
        .readText()
        .then((text) => {
          if (text) pasteText(text);
        })
        .catch(() => showError(t('terminal.feedback.pasteFailed')));
    };
    const handlePaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      pasteText(text);
    };
    element?.addEventListener('contextmenu', handleContextMenu);
    element?.addEventListener('paste', handlePaste);

    return () => {
      selectionDisposable.dispose();
      element?.removeEventListener('contextmenu', handleContextMenu);
      element?.removeEventListener('paste', handlePaste);
      // Reset key handler to avoid stale closures when session changes.
      terminal.attachCustomKeyEventHandler(() => true);
    };
  }, [activeSession?.status, terminal, searchOpen, handleOpenSearch, handleCloseSearch, success, showError, t, copyOnSelect, largePasteWarning, multiLinePasteWarning, rightClickBehavior, trimTrailingWhitespace]);

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-app-bg">
      {searchOpen && (
        <div className="absolute right-0 top-0 z-20 flex h-10 w-96 items-center gap-1.5 rounded-bl-sm border border-t-0 border-app-border bg-app-surface p-1.5 shadow-md">
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
          <Button variant="secondary" size="icon" className="h-7 w-7 shrink-0" onClick={() => performSearch('previous', query)} aria-label={t('terminal.search.previous')}>
            <ChevronUpIcon className="h-4 w-4" />
          </Button>
          <Button variant="secondary" size="icon" className="h-7 w-7 shrink-0" onClick={() => performSearch('next', query)} aria-label={t('terminal.search.next')}>
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
            aria-label={t('terminal.search.caseSensitive')}
            className={cn('h-7 px-1.5 font-mono text-xs', caseSensitive && 'text-app-primary')}
          >
            Aa
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={handleCloseSearch} aria-label={t('terminal.search.close')}>
            <XIcon className="h-4 w-4" />
          </Button>
        </div>
      )}
      {activeSession?.status === 'connecting' && !activeSession.reconnecting && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-app-surface">
          <Spinner />
          <span className="text-xs text-app-text-soft">{t('terminal.status.connecting')}...</span>
        </div>
      )}
      {activeSession?.reconnecting && (
        <ReconnectingIndicator label={t('terminal.notice.reconnectingLabel')} />
      )}
      <div ref={paneRef} className="h-full w-full p-0" />
      <AlertDialog open={Boolean(pendingPaste)} onOpenChange={(open) => { if (!open) setPendingPaste(''); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('terminal.pasteWarning.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('terminal.pasteWarning.description', {
                lines: pendingPaste ? pendingPaste.split(/\r?\n/).length : 0,
                characters: pendingPaste.length,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingPaste('')}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                terminal?.paste(pendingPaste);
                setPendingPaste('');
              }}
            >
              {t('terminal.pasteWarning.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
