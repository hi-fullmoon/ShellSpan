import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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

// Keep the connecting overlay up for at least this long so fast connections
// don't make it flash.
const MIN_CONNECTING_OVERLAY_MS = 600;

// xterm's selection service extends the selection on ANY mousemove while the
// button is held — it has no click-drag threshold. On macOS trackpads with
// "tap to click" enabled, a light tap is delivered as a mousedown and any
// subsequent slide is treated as a held-button drag, so tapping and sliding
// slightly selects a run of cells unintentionally. Native terminals apply a
// click-slop threshold; mirror it here by swallowing sub-threshold mousemove
// events before xterm's document-level selection handler sees them. Eight CSS
// pixels is roughly one terminal cell at the default font size: large enough
// to absorb trackpad tap drift without delaying an intentional cell drag.
const CLICK_DRAG_THRESHOLD_PX = 8;

// Wait for the selection to stop changing before copying it, so a real drag
// that moves the pointer across cells doesn't write every intermediate state
// to the clipboard on its way to the final selection.
export const COPY_ON_SELECT_DEBOUNCE_MS = 250;

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
  const { error: showError } = useToast();
  const copyOnSelect = useAppStore((state) => state.terminalCopyOnSelect);
  const multiLinePasteWarning = useAppStore((state) => state.terminalMultiLinePasteWarning);
  const largePasteWarning = useAppStore((state) => state.terminalLargePasteWarning);
  const trimTrailingWhitespace = useAppStore((state) => state.terminalTrimTrailingWhitespace);
  const rightClickBehavior = useAppStore((state) => state.terminalRightClickBehavior);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [pendingPaste, setPendingPaste] = useState<{ sessionId: string; text: string } | null>(null);
  const activeSessionId = activeSession?.sessionId ?? null;
  const { focus, searchNext, searchPrevious, clearSearch } = useActiveController(
    paneRef,
    activeSessionId,
    isActive,
  );

  const controller = useSyncExternalStore(terminalRegistry.subscribe, () =>
    activeSessionId === null ? undefined : terminalRegistry.get(activeSessionId),
  );
  const terminal = controller?.terminal ?? null;

  const connecting = activeSession?.status === 'connecting' && !activeSession.reconnecting;
  // Once the overlay appears, hold it for MIN_CONNECTING_OVERLAY_MS even if
  // the session connects faster than that.
  const [overlayHold, setOverlayHold] = useState<{ sessionId: string; until: number } | null>(null);

  useEffect(() => {
    if (!connecting || !activeSessionId) return;
    setOverlayHold((prev) =>
      prev?.sessionId === activeSessionId
        ? prev
        : { sessionId: activeSessionId, until: Date.now() + MIN_CONNECTING_OVERLAY_MS },
    );
  }, [connecting, activeSessionId]);

  useEffect(() => {
    if (!overlayHold) return;
    const delay = overlayHold.until - Date.now();
    if (delay <= 0) {
      setOverlayHold(null);
      return;
    }
    const timer = window.setTimeout(() => setOverlayHold(null), delay);
    return () => window.clearTimeout(timer);
  }, [overlayHold]);

  // The hold only smooths the connecting -> connected transition; failures
  // should surface immediately.
  const showConnectingOverlay = Boolean(
    activeSession &&
      (connecting ||
        (overlayHold?.sessionId === activeSession.sessionId &&
          activeSession.status === 'connected')),
  );

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

    let copyTimeout: number | null = null;
    const selectionDisposable = terminal.onSelectionChange(() => {
      if (!copyOnSelect) return;
      if (copyTimeout !== null) window.clearTimeout(copyTimeout);
      copyTimeout = null;
      const current = terminal.getSelection();
      if (!current) return;
      copyTimeout = window.setTimeout(() => {
        copyTimeout = null;
        const selection = terminal.getSelection();
        if (!selection) return;
        const copiedText = trimTrailingWhitespace
          ? selection.replace(/[ \t]+(?=\r?$)/gm, '')
          : selection;
        void navigator.clipboard
          .writeText(copiedText)
          .catch(() => showError(t('terminal.feedback.copyFailed')));
      }, COPY_ON_SELECT_DEBOUNCE_MS);
    });

    const element = terminal.element;
    const pasteText = (text: string): void => {
      if (!activeSessionId) return;
      const isMultiLine = /[\r\n]/.test(text);
      const isLarge = new Blob([text]).size > 5 * 1024;
      if ((multiLinePasteWarning && isMultiLine) || (largePasteWarning && isLarge)) {
        setPendingPaste({ sessionId: activeSessionId, text });
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
      if (copyTimeout !== null) window.clearTimeout(copyTimeout);
      selectionDisposable.dispose();
      element?.removeEventListener('contextmenu', handleContextMenu);
      element?.removeEventListener('paste', handlePaste);
      // Reset key handler to avoid stale closures when session changes.
      terminal.attachCustomKeyEventHandler(() => true);
    };
  }, [activeSession?.status, activeSessionId, terminal, searchOpen, handleOpenSearch, handleCloseSearch, showError, t, copyOnSelect, largePasteWarning, multiLinePasteWarning, rightClickBehavior, trimTrailingWhitespace]);

  // Enforce a click-drag threshold (see CLICK_DRAG_THRESHOLD_PX). xterm
  // registers its selection mousemove handler on document only after the first
  // mousedown; this document-level listener is registered first, so a
  // sub-threshold move is stopped before xterm can extend the selection. The
  // linkifier hover and vim/tmux mouse-reporting handlers live on the terminal
  // element (or are registered later for the same document), so they are
  // unaffected — only the accidental tap-and-slide selection is swallowed.
  useEffect(() => {
    const element = terminal?.element;
    if (!element) return;

    let dragStart: { x: number; y: number } | null = null;

    const finishPotentialTap = (): void => {
      const wasPotentialTap = dragStart !== null;
      dragStart = null;

      // Normally the suppressed mousemove prevents xterm from creating a
      // selection at all. Clear a transient selection as a fallback in case
      // another listener observed the move first (browser/xterm versions can
      // differ in listener ordering).
      if (wasPotentialTap && terminal.hasSelection()) {
        terminal.clearSelection();
      }
    };

    const handleMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) return;
      dragStart = { x: event.clientX, y: event.clientY };
    };
    const handleMouseMove = (event: MouseEvent): void => {
      if (dragStart === null) return;
      // The pointer was released outside the window so mouseup was never seen.
      if (!(event.buttons & 1)) {
        finishPotentialTap();
        return;
      }
      const distance = Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y);
      if (distance < CLICK_DRAG_THRESHOLD_PX) {
        // stopImmediatePropagation is required here: xterm's selection handler
        // is another listener on the same document node and must not run.
        event.stopImmediatePropagation();
      } else {
        // Threshold crossed: this is a real drag, let xterm select normally.
        dragStart = null;
      }
    };
    const handleMouseUp = (): void => {
      finishPotentialTap();
    };

    element.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      element.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [terminal]);

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
      {showConnectingOverlay && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-app-surface">
          <Spinner />
          <span className="text-xs text-app-text-soft">{t('terminal.status.connecting')}...</span>
        </div>
      )}
      {activeSession?.reconnecting && (
        <ReconnectingIndicator label={t('terminal.notice.reconnectingLabel')} />
      )}
      <div ref={paneRef} className="h-full w-full p-0" />
      <AlertDialog open={Boolean(pendingPaste)} onOpenChange={(open) => { if (!open) setPendingPaste(null); }}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('terminal.pasteWarning.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('terminal.pasteWarning.description', {
                lines: pendingPaste ? pendingPaste.text.split(/\r?\n/).length : 0,
                characters: pendingPaste?.text.length ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingPaste(null)}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingPaste) {
                  terminalRegistry.get(pendingPaste.sessionId)?.terminal.paste(pendingPaste.text);
                }
                setPendingPaste(null);
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
