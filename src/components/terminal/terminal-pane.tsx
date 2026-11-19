import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { useActiveController } from '@/components/terminal/hooks/use-active-controller';
import { resolveTerminalTheme, terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { handleTerminalLeaderKeydown } from '@/components/terminal/terminal-leader';
import { installTerminalSelectionGuard } from '@/components/terminal/terminal-selection-guard';
import { useTerminalStore, type TerminalSession as TerminalSessionState } from '@/stores/terminalStore';
import { useToast } from '@/hooks/useToast';
import { getPlatform } from '@/lib/platform';
import { copyTerminalText, installTerminalPasteHandler } from './terminal-clipboard';
import { terminalInputReadiness } from './terminal-input-readiness';
import { agentTerminalCommandFeedback } from './agent-terminal-command-feedback';
import { TerminalSearch } from './terminal-search';
import { TerminalResizeIndicator } from './terminal-resize-indicator';
import { TerminalPastePreview } from './terminal-paste-preview';
import { TerminalContentMenu } from './terminal-content-menu';
import { openTerminalTask, terminalTaskWorkspace, useTerminalTaskNavigation } from './agent-terminal-task-navigation';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useFocusStore } from '@/stores/focusStore';
import { eventMatchesShortcut } from '@/lib/shortcuts';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import type { ShortcutBindings } from '@/types';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  agentTerminalLeaseState,
  type AgentTerminalLeaseView,
} from '@/components/terminal/agent-terminal-lease-state';
import { ArrowUpRightIcon, TerminalIcon } from 'lucide-react';

const effectiveShortcuts = (): ShortcutBindings => ({
  ...DEFAULT_SHORTCUTS,
  ...useAppStore.getState().shortcuts,
});

// Keep the connecting overlay up for at least this long so fast connections
// don't make it flash.
const MIN_CONNECTING_OVERLAY_MS = 600;

const AgentTerminalLeaseBar: React.FC<{
  lease: AgentTerminalLeaseView;
  inputLocked: boolean;
}> = ({ lease, inputLocked }) => {
  const { t } = useI18n();
  const { error: showError } = useToast();
  const focusEnabled = useFocusStore(state => state.enabled);
  const panelOpen = useAiPanelStore(state => state.panelOpenBySection.terminal);
  const activeSection = useAppStore(state => state.activeSection);
  const workspace = focusEnabled ? 'focus' : 'terminal';
  const ownerWorkspace = terminalTaskWorkspace(lease);
  const displayedSessionId = useTerminalTaskNavigation(state => state.displayedSessionByWorkspace[workspace]);
  const taskVisible = activeSection === 'terminal'
    && (focusEnabled || panelOpen)
    && ownerWorkspace === workspace
    && displayedSessionId === lease.agentSessionId;
  const shownFailureOperationRef = useRef<string | null>(null);
  useEffect(() => {
    if (!lease.takeoverFailed) {
      if (shownFailureOperationRef.current === lease.operationId) {
        shownFailureOperationRef.current = null;
      }
      return;
    }
    if (shownFailureOperationRef.current === lease.operationId) return;
    shownFailureOperationRef.current = lease.operationId;
    showError(t('terminal.agentLease.takeoverFailed'));
  }, [lease.operationId, lease.takeoverFailed, showError, t]);
  const feedback = agentTerminalCommandFeedback(lease);
  const activityLabel = lease.terminalOwned
    ? t(feedback.label)
    : t(lease.waitingForUserAction ? 'terminal.agentLease.waitingForUserAction' : 'terminal.agentLease.turnRunning');
  const interactionHint = lease.terminalOwned
    ? t(lease.inputBlocked ? 'terminal.agentLease.inputBlockedAccessibleHint' : feedback.hint)
    : null;
  const modeLabel = t('terminal.agentLease.visibleCommandLabel');
  const workspaceLabel = t(ownerWorkspace === 'focus' ? 'terminal.occupancy.focus' : 'terminal.occupancy.terminal');
  const inputLabel = inputLocked ? t('terminal.agentLease.inputLockedLabel') : null;
  const viewTaskLabel = t('terminal.occupancy.viewTask');

  return (
    <div
      className="@container/terminal-lease shrink-0 bg-app-surface"
      data-testid="agent-terminal-lease-bar"
      data-operation-id={lease.operationId}
      data-terminal-owned={lease.terminalOwned || undefined}
      data-input-blocked={lease.inputBlocked || undefined}
    >
      <div className="flex min-w-0 items-center gap-2 px-1 py-0.5">
        <div className="agent-terminal-lease-status flex min-w-0 flex-1 items-center gap-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={<span />}
                className="grid size-6 shrink-0 place-items-center rounded-md bg-app-surface-muted text-app-primary"
                data-testid="agent-terminal-lease-identity"
              >
                <TerminalIcon aria-hidden="true" className="size-3" />
              </TooltipTrigger>
              <TooltipContent align="start" side="bottom">
                {modeLabel} · {workspaceLabel} · {t('terminal.agentLease.agentIdentity', { id: lease.agentSessionId })}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <div className="min-w-0" aria-hidden="true">
            <div className="agent-terminal-lease-description truncate text-xs leading-4 font-semibold text-app-text" title={interactionHint ? `${activityLabel} — ${interactionHint}` : activityLabel}>
              {activityLabel}
            </div>
            <div className="flex items-center gap-1 text-[11px] leading-3.5 text-app-text-soft">
              <span className={inputLabel ? 'hidden truncate @min-[420px]/terminal-lease:inline' : 'truncate'}>{modeLabel}</span>
              {inputLabel && <>
                <span className="hidden @min-[420px]/terminal-lease:inline">·</span>
                <span className="shrink-0">{inputLabel}</span>
              </>}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!taskVisible && <Button
            type="button"
            variant="ghost"
            size="xs"
            className="@max-[420px]/terminal-lease:w-6 @max-[420px]/terminal-lease:px-0"
            title={viewTaskLabel}
            onClick={() => {
              if (!openTerminalTask(lease)) showError(t('terminal.occupancy.navigationBlocked'));
            }}
          >
            <ArrowUpRightIcon aria-hidden="true" className="@min-[420px]/terminal-lease:hidden" />
            <span className="@max-[420px]/terminal-lease:sr-only">{viewTaskLabel}</span>
          </Button>}
          {!lease.waitingForUserAction && <Button
            type="button"
            variant="secondary"
            size="xs"
            className="agent-terminal-takeover"
            disabled={lease.takeoverRequested}
            aria-busy={lease.takeoverRequested || undefined}
            onClick={lease.requestTakeover}
          >
            {t(lease.takeoverRequested ? 'terminal.agentLease.takingOver' : 'terminal.agentLease.takeover')}
          </Button>}
        </div>
      </div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {[activityLabel, modeLabel, workspaceLabel, inputLabel, interactionHint].filter(Boolean).join(' · ')}
      </span>
    </div>
  );
};

// Wait for the selection to stop changing before copying it, so a real drag
// that moves the pointer across cells doesn't write every intermediate state
// to the clipboard on its way to the final selection.
export const COPY_ON_SELECT_DEBOUNCE_MS = 250;

const TerminalPromptIndicator: React.FC<{
  label: string;
  animatedDots?: boolean;
}> = ({ label, animatedDots = false }) => (
  <div
    className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
    role="status"
    aria-label={label}
  >
    <span className="rounded-sm bg-app-surface/90 px-3 py-1.5 font-mono text-sm text-app-text-soft shadow-sm">
      <span aria-hidden="true">
        {label}
        {animatedDots && [0, 1, 2].map((index) => (
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
  isVisible?: boolean;
}

export const TerminalPane: React.FC<TerminalPaneProps> = ({
  activeSession,
  isActive = true,
  isVisible = true,
}) => {
  const paneRef = useRef<HTMLDivElement>(null);
  const resizeBoundaryRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();
  const { error: showError } = useToast();
  const copyOnSelect = useAppStore((state) => state.terminalCopyOnSelect);
  const multiLinePasteWarning = useAppStore((state) => state.terminalMultiLinePasteWarning);
  const largePasteWarning = useAppStore((state) => state.terminalLargePasteWarning);
  const trimTrailingWhitespace = useAppStore((state) => state.terminalTrimTrailingWhitespace);
  const colorScheme = useAppStore((state) => state.terminalColorScheme);
  const colorOverrides = useAppStore((state) => state.terminalColorOverrides);
  const terminalTheme = colorScheme === 'app' ? colorOverrides : resolveTerminalTheme(colorScheme, colorOverrides);
  const terminalSurfaceStyle: React.CSSProperties = {
    backgroundColor: terminalTheme?.background ?? 'var(--app-surface)',
    color: terminalTheme?.foreground ?? 'var(--app-text)',
  };
  const [searchOpen, setSearchOpen] = useState(false);
  const [pendingPaste, setPendingPaste] = useState<{ sessionId: string; text: string; target: string } | null>(null);
  const activeSessionId = activeSession?.sessionId ?? null;
  const currentSessionIdRef = useRef(activeSessionId);
  currentSessionIdRef.current = activeSessionId;
  const controller = useSyncExternalStore(terminalRegistry.subscribe, () =>
    activeSessionId === null ? undefined : terminalRegistry.get(activeSessionId),
  );
  const terminal = controller?.terminal ?? null;
  const searchAddon = controller?.searchAddon;
  const preparingInput = useSyncExternalStore(
    terminalInputReadiness.subscribe,
    () => terminalInputReadiness.isPreparing(activeSessionId),
  );
  const activeLease = useSyncExternalStore(
    agentTerminalLeaseState.subscribe,
    () => agentTerminalLeaseState.get(activeSessionId),
  );
  const inputLocked = !!activeLease && agentTerminalLeaseState.blocksUserInput(
    activeLease.sessionId, activeSession?.foregroundHandoffActive,
  );
  const agentTyping = inputLocked && activeLease.terminalOwned && activeLease.commandExecution !== false
    && agentTerminalCommandFeedback(activeLease).label === 'terminal.agentLease.commandTyping';
  const { focus, clearSearch } = useActiveController(paneRef, activeSessionId, isActive && !searchOpen, isVisible);

  useLayoutEffect(() => {
    if (!terminal || !agentTyping) return;
    const previous = terminal.options.cursorInactiveStyle;
    terminal.options.cursorInactiveStyle = 'block';
    // xterm initializes the cursor on first keyboard focus. Agent typing can
    // be the first interaction, so initialize the renderer without focusing it.
    const { _core } = terminal as unknown as { _core?: { _showCursor?: () => void } };
    _core?._showCursor?.();
    return () => { terminal.options.cursorInactiveStyle = previous; };
  }, [terminal, agentTyping]);

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
  const showPreparingInputPrompt = preparingInput && activeSession?.status === 'connected' && !activeSession.reconnecting;
  const showInputBlockedPrompt = activeLease?.inputBlocked && !activeSession?.reconnecting && !preparingInput;
  const showResizeIndicator = isVisible && !showConnectingOverlay && !activeSession?.reconnecting
    && !showPreparingInputPrompt && !showInputBlockedPrompt;

  const handleOpenSearch = useCallback((): void => {
    setSearchOpen(true);
  }, []);

  const handleCloseSearch = useCallback((): void => {
    clearSearch();
    setSearchOpen(false);
    focus();
  }, [clearSearch, focus]);

  const pasteText = useCallback((text: string): void => {
    if (!activeSessionId || !text || !terminal) return;
    const session = useTerminalStore.getState().sessions.find(item => item.sessionId === activeSessionId);
    if (currentSessionIdRef.current !== activeSessionId || session?.status !== 'connected'
      || terminalRegistry.get(activeSessionId)?.terminal !== terminal
      || terminalInputReadiness.isPreparing(activeSessionId)
      || agentTerminalLeaseState.blocksUserInput(activeSessionId, session.foregroundHandoffActive)) {
      showError(t('terminal.feedback.pasteUnavailable'));
      return;
    }
    if ((multiLinePasteWarning && /[\r\n]/.test(text))
      || (largePasteWarning && new Blob([text]).size > 5 * 1024)) {
      setPendingPaste({ sessionId: activeSessionId, text,
        target: `${session.title} (${session.username}@${session.host}:${session.port})` });
      return;
    }
    terminal.paste(text);
  }, [activeSessionId, terminal, multiLinePasteWarning, largePasteWarning, showError, t]);

  useEffect(() => {
    if (!isActive) return;
    const handleOpenSearchRequest = (): void => handleOpenSearch();
    document.addEventListener('shellspan:find-terminal', handleOpenSearchRequest);
    return () => document.removeEventListener('shellspan:find-terminal', handleOpenSearchRequest);
  }, [handleOpenSearch, isActive]);

  // Bind xterm custom key handler for app shortcuts, find/escape, and copy.
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
      const isTabSwitcherShortcut = eventMatchesShortcut(
        event,
        effectiveShortcuts().switchTerminalTab,
      );

      // Document-level handlers run after xterm's textarea handler. Consume
      // the chord here so it opens the app UI without first writing a control
      // sequence to the active remote shell.
      if (isTabSwitcherShortcut) {
        event.preventDefault();
        event.stopPropagation();
        document.dispatchEvent(new Event('shellspan:switch-terminal-tab'));
        return false;
      }

      if (isFindShortcut) {
        event.preventDefault();
        event.stopPropagation();
        document.dispatchEvent(new Event('shellspan:find-terminal'));
        return false;
      }

      if (isCopyShortcut) {
        const selection = terminal.getSelection();
        if (selection) {
          event.preventDefault();
          const copiedText = trimTrailingWhitespace
            ? selection.replace(/[ \t]+(?=\r?$)/gm, '')
            : selection;
          void copyTerminalText(copiedText);
          return false;
        }
      }

      if (event.key === 'Escape') {
        if (activeLease && !activeLease.waitingForUserAction) {
          event.preventDefault();
          event.stopPropagation();
          activeLease.requestTakeover();
          return false;
        }
        if (searchOpen) {
          event.preventDefault();
          handleCloseSearch();
          return false;
        }
      }

      return true;
    });

    const disposePaste = installTerminalPasteHandler(terminal, pasteText, () => showError(t('terminal.feedback.pasteFailed')));

    return () => {
      disposePaste?.();
      // Reset key handler to avoid stale closures when session changes.
      terminal.attachCustomKeyEventHandler(() => true);
    };
  }, [activeLease, activeSession, activeSessionId, terminal, searchOpen, handleOpenSearch, handleCloseSearch, showError, t, largePasteWarning, multiLinePasteWarning, trimTrailingWhitespace, pasteText]);

  // Session observations and shortcut UI can rerender while a drag settles.
  // Keep its copy timer scoped to the displayed terminal and copy preferences.
  useEffect(() => {
    if (!terminal || !copyOnSelect) return;
    let copyTimeout: number | null = null;
    const selectionDisposable = terminal.onSelectionChange(() => {
      if (copyTimeout !== null) window.clearTimeout(copyTimeout);
      copyTimeout = null;
      if (searchAddon?.selectingMatch || !terminal.getSelection()) return;
      copyTimeout = window.setTimeout(() => {
        copyTimeout = null;
        const selection = terminal.getSelection();
        if (!selection) return;
        const copiedText = trimTrailingWhitespace
          ? selection.replace(/[ \t]+(?=\r?$)/gm, '')
          : selection;
        void copyTerminalText(copiedText);
      }, COPY_ON_SELECT_DEBOUNCE_MS);
    });
    return () => {
      if (copyTimeout !== null) window.clearTimeout(copyTimeout);
      selectionDisposable.dispose();
    };
  }, [activeSessionId, terminal, searchAddon, copyOnSelect, trimTrailingWhitespace]);

  // useActiveController opens xterm in a layout effect only when visible.
  // Install after that effect, including the first hidden -> visible transition.
  useLayoutEffect(() => {
    if (!terminal || !isVisible) return;
    return installTerminalSelectionGuard(terminal);
  }, [terminal, isVisible]);

  return (
    <div ref={resizeBoundaryRef} className="relative flex h-full w-full flex-col overflow-hidden bg-app-bg" data-terminal-pane-session={activeSessionId}>
      {activeLease && (
        <AgentTerminalLeaseBar
          lease={activeLease}
          inputLocked={inputLocked}
        />
      )}
      <div className="relative min-h-0 flex-1" style={{ backgroundColor: terminalSurfaceStyle.backgroundColor }}>
        {activeLease && !activeLease.waitingForUserAction && (
          <div
            className="agent-visible-terminal-aura pointer-events-none absolute inset-0 z-10"
            data-testid="agent-visible-terminal-aura"
            aria-hidden="true"
          />
        )}
        {searchOpen && (
          <TerminalSearch addon={searchAddon} onClose={handleCloseSearch} active={isActive && isVisible} />
        )}
        {showConnectingOverlay && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2" style={terminalSurfaceStyle}>
            <Spinner />
            <span className="text-xs">{t('terminal.status.connecting')}...</span>
          </div>
        )}
        {activeSession?.reconnecting && (
          <TerminalPromptIndicator
            label={activeSession.status === 'connecting' && activeSession.statusMessage
              ? activeSession.statusMessage : t('terminal.notice.reconnectingLabel')}
            animatedDots
          />
        )}
        {showPreparingInputPrompt && (
          <TerminalPromptIndicator label={t('terminal.notice.preparingInput')} animatedDots />
        )}
        {showInputBlockedPrompt && (
          <TerminalPromptIndicator
            label={t('terminal.agentLease.inputBlockedPrompt')}
          />
        )}
        <TerminalContentMenu session={activeSession} terminal={terminal} onPaste={pasteText} onSearch={handleOpenSearch}>
          <div ref={paneRef} data-terminal-measure-session={activeSession?.sessionId} className="h-full w-full p-0" />
        </TerminalContentMenu>
        {showResizeIndicator && terminal && (
          <TerminalResizeIndicator key={`resize:${activeSessionId}`} terminal={terminal} boundary={resizeBoundaryRef} />
        )}
      </div>
      <ConfirmationDialog
        open={Boolean(pendingPaste)}
        onOpenChange={(open) => { if (!open) setPendingPaste(null); }}
        title={t('terminal.pasteWarning.title')}
        description={t('terminal.pasteWarning.description', {
          lines: pendingPaste ? pendingPaste.text.split(/\r\n|\r|\n/).length : 0,
          characters: pendingPaste?.text.length ?? 0,
        })}
        confirmLabel={t('terminal.pasteWarning.confirm')}
        onConfirm={() => {
          if (pendingPaste) {
            const target = terminalRegistry.get(pendingPaste.sessionId);
            const targetSession = useTerminalStore.getState().sessions.find((session) => session.sessionId === pendingPaste.sessionId);
            if (!target || targetSession?.status !== 'connected'
              || terminalInputReadiness.isPreparing(pendingPaste.sessionId)
              || agentTerminalLeaseState.blocksUserInput(pendingPaste.sessionId, targetSession.foregroundHandoffActive)) {
              showError(t('terminal.feedback.pasteUnavailable'));
            } else {
              target.terminal.paste(pendingPaste.text);
            }
          }
          setPendingPaste(null);
        }}
      >
        {pendingPaste && <TerminalPastePreview text={pendingPaste.text} target={pendingPaste.target} />}
      </ConfirmationDialog>
    </div>
  );
};
