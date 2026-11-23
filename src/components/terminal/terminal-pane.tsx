import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Spinner } from '@/components/ui/empty-state';
import { useI18n } from '@/hooks/useI18n';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { useActiveController } from '@/components/terminal/hooks/use-active-controller';
import { resolveTerminalTheme, terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { handleTerminalLeaderKeydown } from '@/components/terminal/terminal-leader';
import { installTerminalSelectionGuard } from '@/components/terminal/terminal-selection-guard';
import { useTerminalStore, type TerminalSession as TerminalSessionState } from '@/stores/terminalStore';
import { useReconnectSession } from '@/hooks/useReconnectSession';
import { useToast } from '@/hooks/useToast';
import { getPlatform } from '@/lib/platform';
import { copyTerminalText, installTerminalPasteHandler } from './terminal-clipboard';
import { terminalInputReadiness } from './terminal-input-readiness';
import { agentTerminalCommandFeedback } from './agent-terminal-command-feedback';
import { TerminalSearch } from './terminal-search';
import { TerminalResizeIndicator } from './terminal-resize-indicator';
import { TerminalPastePreview } from './terminal-paste-preview';
import { clearTerminalScreen, TerminalContentMenu } from './terminal-content-menu';
import { TerminalCommandBlockOverlay } from './terminal-command-block-overlay';
import { openTerminalTask, terminalTaskWorkspace } from './agent-terminal-task-navigation';
import { useAgentQuestionStore } from '@/stores/agentQuestionStore';
import { useAiDraftStore } from '@/stores/aiDraftStore';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useFocusStore } from '@/stores/focusStore';
import { eventMatchesShortcut } from '@/lib/shortcuts';
import { terminalFontSizeAfterKey } from '@/lib/terminal/terminal-font';
import { getTerminalBroadcastTargets } from '@/stores/terminalBroadcastStore';
import { cn } from '@/lib/utils';
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
import { LockIcon, RadioTowerIcon, TerminalIcon, TriangleAlertIcon } from 'lucide-react';

const effectiveShortcuts = (): ShortcutBindings => ({
  ...DEFAULT_SHORTCUTS,
  ...useAppStore.getState().shortcuts,
});

// Keep the connecting overlay up for at least this long so fast connections
// don't make it flash.
const MIN_CONNECTING_OVERLAY_MS = 600;

const AgentTerminalStatusBar: React.FC<{
  lease: AgentTerminalLeaseView;
  inputLocked: boolean;
}> = ({ lease, inputLocked }) => {
  const { t } = useI18n();
  const { error: showError } = useToast();
  const ownerWorkspace = terminalTaskWorkspace(lease);
  const handoffControl = useAgentQuestionStore((state) => (
    lease.waitingForUserAction ? state.handoffControls[lease.agentSessionId] : undefined
  ));
  const { operationId, takeoverFailed } = lease;
  const shownFailureOperationRef = useRef<string | null>(null);
  useEffect(() => {
    if (!takeoverFailed) {
      if (shownFailureOperationRef.current === operationId) {
        shownFailureOperationRef.current = null;
      }
      return;
    }
    if (shownFailureOperationRef.current === operationId) return;
    shownFailureOperationRef.current = operationId;
    showError(t('terminal.agentLease.takeoverFailed'));
  }, [operationId, takeoverFailed, showError, t]);
  const feedback = lease.terminalOwned ? agentTerminalCommandFeedback(lease) : null;
  const activityLabel = feedback
    ? t(feedback.label)
    : t(lease.waitingForUserAction ? 'terminal.agentLease.waitingForUserAction' : 'terminal.agentLease.turnRunning');
  const interactionHint = feedback
    ? t(lease.inputBlocked ? 'terminal.agentLease.inputBlockedAccessibleHint' : feedback.hint)
    : null;
  const modeLabel = t('terminal.agentLease.visibleCommandLabel');
  const workspaceLabel = t(ownerWorkspace === 'focus' ? 'terminal.occupancy.focus' : 'terminal.occupancy.terminal');
  const inputLabel = inputLocked ? t('terminal.agentLease.inputLockedLabel') : null;
  const identity = (
    <span className="grid size-5 shrink-0 place-items-center rounded-md bg-app-surface-muted/60 text-app-primary/80"
      data-testid="agent-terminal-lease-identity">
      <TerminalIcon aria-hidden="true" className="size-3" />
    </span>
  );

  const statusSummary = (
    <div className={cn(
      'agent-terminal-lease-status flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden',
      !lease.waitingForUserAction && '@max-[160px]/terminal-lease:hidden',
    )}>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={identity} />
          <TooltipContent align="start" side="bottom">
            {modeLabel} · {workspaceLabel} · {t('terminal.agentLease.agentIdentity', { id: lease.agentSessionId })}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <div className="flex min-w-0 flex-col @max-[220px]/terminal-lease:hidden @min-[420px]/terminal-lease:flex-row @min-[420px]/terminal-lease:items-center @min-[420px]/terminal-lease:gap-1.5" aria-hidden="true">
        <div className="agent-terminal-lease-description truncate text-xs leading-3.5 font-semibold text-app-text/85" title={interactionHint ? `${activityLabel} — ${interactionHint}` : activityLabel}>
          {activityLabel}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-[11px] leading-3 text-app-text-soft/85">
          <span className={cn('truncate', inputLocked && 'hidden @min-[520px]/terminal-lease:inline')}>{modeLabel}</span>
          {inputLabel && <>
            <span className={cn(inputLocked && 'hidden @min-[520px]/terminal-lease:inline')}>·</span>
            <span className="truncate">{inputLabel}</span>
          </>}
        </div>
      </div>
    </div>
  );

  if (lease.waitingForUserAction) {
    return (
      <div
        className="@container/terminal-lease flex shrink-0 items-center justify-between gap-2 border-b border-app-border/50 bg-app-surface px-2.5 py-1 text-xs text-app-text"
        data-testid="agent-terminal-lease-bar"
        data-layout="banner"
        data-operation-id={lease.operationId}
        data-terminal-owned={lease.terminalOwned || undefined}
        data-input-blocked={lease.inputBlocked || undefined}
      >
        {statusSummary}
        {handoffControl && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="agent-terminal-handoff-issue max-w-full truncate @max-[260px]/terminal-lease:hidden"
              disabled={handoffControl.pending}
              onClick={() => {
                openTerminalTask(lease);
                handoffControl.openFeedback();
              }}
            >
              {t('ai.workspace.question.actionReportIssue')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="agent-terminal-handoff-complete max-w-full truncate"
              disabled={handoffControl.pending}
              aria-busy={handoffControl.pending || undefined}
              onClick={handoffControl.complete}
            >
              {t(handoffControl.pending ? 'ai.workspace.question.submitting' : 'ai.workspace.question.actionComplete')}
            </Button>
          </div>
        )}
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {[activityLabel, modeLabel, workspaceLabel, inputLabel, interactionHint].filter(Boolean).join(' · ')}
        </span>
      </div>
    );
  }

  return (
    <div
      className="@container/terminal-lease pointer-events-none absolute inset-x-2 top-2 z-20 flex justify-center"
      data-testid="agent-terminal-lease-bar"
      data-layout="floating"
      data-operation-id={lease.operationId}
      data-terminal-owned={lease.terminalOwned || undefined}
      data-input-blocked={lease.inputBlocked || undefined}
    >
      <div className="pointer-events-auto flex w-fit max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border border-app-border/45 bg-app-surface/55 p-1 shadow-xs backdrop-blur-md motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-safe:ease-out">
        {statusSummary}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="secondary"
            size="xs"
            className="agent-terminal-takeover max-w-full truncate bg-secondary/65 text-secondary-foreground/85 hover:bg-secondary/85"
            disabled={lease.takeoverRequested}
            aria-busy={lease.takeoverRequested || undefined}
            onClick={lease.requestTakeover}
          >
            {t(lease.takeoverRequested ? 'terminal.agentLease.takingOver' : 'terminal.agentLease.takeover')}
          </Button>
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

function formatPasteTargetLabel(session: TerminalSessionState): string {
  return session.host === 'local' && session.port === 0
    ? session.title
    : `${session.title} (${session.username}@${session.host}:${session.port})`;
}

const TerminalPromptIndicator: React.FC<{
  label: string;
  animatedDots?: boolean;
}> = ({ label, animatedDots = false }) => (
  <div
    className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
    role="status"
    aria-label={label}
  >
    <span className="inline-flex items-center gap-1 rounded-sm border border-border/60 bg-app-surface/95 px-3 py-1.5 font-mono text-sm text-app-text-soft shadow-sm">
      {animatedDots && (
        <Spinner className="size-3.5" role={undefined} aria-label={undefined} aria-hidden="true" />
      )}
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
  const reconnectSession = useReconnectSession();
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
  const [searchInitialQuery, setSearchInitialQuery] = useState('');
  const [pendingPaste, setPendingPaste] = useState<{
    sessionId: string;
    text: string;
    target: string;
    targets: string[];
    targetLabels: string[];
  } | null>(null);
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
    if (searchOpen) return;
    const selection = terminal?.getSelection() ?? '';
    setSearchInitialQuery(selection.trim() && !/[\r\n]/.test(selection) ? selection : '');
    setSearchOpen(true);
  }, [searchOpen, terminal]);

  const handleCloseSearch = useCallback((): void => {
    clearSearch();
    setSearchOpen(false);
    focus();
  }, [clearSearch, focus]);

  const pasteText = useCallback((text: string): void => {
    if (!activeSessionId || !text || !terminal) return;
    const session = useTerminalStore.getState().sessions.find(item => item.sessionId === activeSessionId);
    const controller = terminalRegistry.get(activeSessionId);
    if (currentSessionIdRef.current !== activeSessionId || session?.status !== 'connected'
      || session.pendingConnection
      || session.readOnly
      || !controller || controller.terminal !== terminal
      || terminalInputReadiness.isPreparing(activeSessionId)
      || agentTerminalLeaseState.blocksUserInput(activeSessionId, session.foregroundHandoffActive)) {
      showError(t('terminal.feedback.pasteUnavailable'));
      return;
    }
    const targets = getTerminalBroadcastTargets(activeSessionId);
    const multiline = /[\r\n]/.test(text);
    const large = new Blob([text]).size > 5 * 1024;
    if (((multiLinePasteWarning || targets.length > 0) && multiline)
      || ((largePasteWarning || targets.length > 0) && large)) {
      const sessionsById = new Map(
        useTerminalStore.getState().sessions.map((item) => [item.sessionId, item]),
      );
      const targetLabels = targets.length > 0
        ? [
            formatPasteTargetLabel(session),
            ...targets
              .map((id) => sessionsById.get(id))
              .filter((item): item is TerminalSessionState => Boolean(item))
              .map(formatPasteTargetLabel),
          ]
        : [];
      setPendingPaste({
        sessionId: activeSessionId,
        text,
        targets,
        target: formatPasteTargetLabel(session),
        targetLabels,
      });
      return;
    }
    if (targets.length) controller.pasteUserText(text, true);
    else terminal.paste(text);
  }, [activeSessionId, terminal, multiLinePasteWarning, largePasteWarning, showError, t]);

  useEffect(() => {
    if (!isActive) return;
    const handleOpenSearchRequest = (): void => handleOpenSearch();
    const handleClearScreen = (): void => {
      if (!terminal || !activeSessionId) return;
      void clearTerminalScreen(terminal, activeSessionId).then((result) => {
        if (result !== 'requested') {
          showError(t(result === 'unavailable' ? 'terminal.menu.clearUnavailable' : 'terminal.menu.clearBlocked'));
        }
      }).catch(() => {
        showError(t('terminal.notice.writeFailedLabel'));
      });
    };
    const handleScrollBottom = (): void => {
      terminal?.scrollToBottom();
    };
    const handleSendToAi = (): void => {
      if (!terminal || !activeSessionId) return;
      const selection = terminal.getSelection();
      if (!selection) return;
      const session = useTerminalStore.getState().sessions.find((item) => item.sessionId === activeSessionId);
      const focus = useFocusStore.getState().enabled;
      const text = `${t('terminal.menu.source', { target: session?.title ?? '' })}\n${selection}`;
      useAiDraftStore.getState().insertTerminalText(`${focus ? 'focus' : 'terminal'}:${activeSessionId}`, text);
      if (!focus) useTerminalStore.getState().setActiveSession(activeSessionId);
      useAiPanelStore.getState().setOpen(true, 'terminal');
    };
    document.addEventListener('shellspan:find-terminal', handleOpenSearchRequest);
    document.addEventListener('shellspan:clear-terminal-screen', handleClearScreen);
    document.addEventListener('shellspan:scroll-terminal-bottom', handleScrollBottom);
    document.addEventListener('shellspan:send-terminal-to-ai', handleSendToAi);
    return () => {
      document.removeEventListener('shellspan:find-terminal', handleOpenSearchRequest);
      document.removeEventListener('shellspan:clear-terminal-screen', handleClearScreen);
      document.removeEventListener('shellspan:scroll-terminal-bottom', handleScrollBottom);
      document.removeEventListener('shellspan:send-terminal-to-ai', handleSendToAi);
    };
  }, [activeSessionId, handleOpenSearch, isActive, showError, t, terminal]);

  const keyPasteHandlersRef = useRef({
    activeLease,
    searchOpen,
    handleCloseSearch,
    showError,
    t,
    trimTrailingWhitespace,
    pasteText,
  });
  keyPasteHandlersRef.current = {
    activeLease,
    searchOpen,
    handleCloseSearch,
    showError,
    t,
    trimTrailingWhitespace,
    pasteText,
  };

  // Bind xterm custom key handler for app shortcuts, find/escape, and copy.
  useEffect(() => {
    if (!terminal) return;

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const latest = keyPasteHandlersRef.current;

      // Leader-key chords (default Ctrl+B then a command key) are resolved
      // before anything else and never reach the pty.
      if (handleTerminalLeaderKeydown(event)) {
        event.preventDefault();
        event.stopPropagation();
        return false;
      }

      const platform = getPlatform();
      const settings = useAppStore.getState();
      const fontSize = terminalFontSizeAfterKey(event, platform, settings.terminalFontSize);
      if (fontSize !== null) {
        event.preventDefault();
        event.stopPropagation();
        settings.setTerminalFontSize(fontSize);
        return false;
      }
      const isCopyShortcut =
        (platform === 'macos' && event.metaKey && event.key.toLowerCase() === 'c') ||
        (platform !== 'macos' && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c');

      // Find follows the configurable binding so it cannot diverge from the
      // app-level shortcut map. Copy stays hardcoded: it mirrors the OS
      // clipboard convention whose default differs per platform.
      const shortcuts = effectiveShortcuts();
      const isFindShortcut = eventMatchesShortcut(event, shortcuts.findTerminal);
      const isTabSwitcherShortcut = eventMatchesShortcut(
        event,
        shortcuts.switchTerminalTab,
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

      if (
        eventMatchesShortcut(event, shortcuts.terminalClearScreen)
        || eventMatchesShortcut(event, shortcuts.terminalSendToAi)
        || eventMatchesShortcut(event, shortcuts.openShortcuts)
        || eventMatchesShortcut(event, shortcuts.toggleFocusMode)
      ) {
        return false;
      }

      if (isCopyShortcut) {
        const selection = terminal.getSelection();
        if (selection) {
          event.preventDefault();
          const copiedText = latest.trimTrailingWhitespace
            ? selection.replace(/[ \t]+(?=\r?$)/gm, '')
            : selection;
          void copyTerminalText(copiedText);
          return false;
        }
      }

      if (event.key === 'Escape') {
        if (latest.activeLease && !latest.activeLease.waitingForUserAction) {
          event.preventDefault();
          event.stopPropagation();
          latest.activeLease.requestTakeover();
          return false;
        }
        if (latest.searchOpen) {
          event.preventDefault();
          latest.handleCloseSearch();
          return false;
        }
      }

      return true;
    });

    const disposePaste = installTerminalPasteHandler(
      terminal,
      (text) => keyPasteHandlersRef.current.pasteText(text),
      () => keyPasteHandlersRef.current.showError(keyPasteHandlersRef.current.t('terminal.feedback.pasteFailed')),
    );

    return () => {
      disposePaste?.();
      // Reset key handler to avoid stale closures when terminal changes.
      terminal.attachCustomKeyEventHandler(() => true);
    };
  }, [terminal]);

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
      {activeSession?.readOnly && <div role="status" className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-b border-app-border/50 bg-app-surface px-2.5 py-1 text-xs text-app-text">
        <span className="flex items-center gap-1"><LockIcon aria-hidden="true" className="size-3.5 shrink-0 text-app-text-soft" />{t('terminal.inputLock.label')}</span>
        <Button type="button" size="xs" variant="ghost" onClick={() => {
          useTerminalStore.getState().toggleReadOnly(activeSession.sessionId);
          focus();
        }}>{t('terminal.inputLock.unlock')}</Button>
      </div>}
      {activeSession?.status === 'connected' && activeSession.nativeRecoveryRequired && !activeSession.reconnecting && !activeLease && (
        <div role="status" data-terminal-recovery-bar className="flex shrink-0 flex-wrap items-center justify-between gap-1 border-b border-app-border/50 bg-app-surface px-2.5 py-1 text-xs text-app-text">
          <span className="flex items-center gap-1"><TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0 text-warning" />{t('terminal.notice.inputRecoveryRequired')}</span>
          <Button type="button" size="xs" variant="ghost" onClick={() => {
            void reconnectSession(activeSession.sessionId);
          }}>{t('terminal.menu.reconnect')}</Button>
        </div>
      )}
      {activeLease?.waitingForUserAction && (
        <AgentTerminalStatusBar
          lease={activeLease}
          inputLocked={inputLocked}
        />
      )}
      <div className="relative min-h-0 flex-1 pl-1.5"
        style={{ backgroundColor: terminalSurfaceStyle.backgroundColor }}>
        {activeLease && !activeLease.waitingForUserAction && (
          <>
            <div
              className="agent-visible-terminal-aura pointer-events-none absolute inset-0 z-10"
              data-testid="agent-visible-terminal-aura"
              aria-hidden="true"
            />
            <AgentTerminalStatusBar
              lease={activeLease}
              inputLocked={inputLocked}
            />
          </>
        )}
        {searchOpen && (
          <TerminalSearch addon={searchAddon} initialQuery={searchInitialQuery} onClose={handleCloseSearch} active={isActive && isVisible} />
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
        {terminal && activeSessionId && activeSession?.currentDirectory && <TerminalCommandBlockOverlay terminal={terminal} sessionId={activeSessionId} />}
        {showResizeIndicator && terminal && (
          <TerminalResizeIndicator key={`resize:${activeSessionId}`} terminal={terminal} boundary={resizeBoundaryRef} />
        )}
      </div>
      <ConfirmationDialog
        open={Boolean(pendingPaste)}
        onOpenChange={(open) => { if (!open) setPendingPaste(null); }}
        title={t(pendingPaste?.targets.length ? 'terminal.broadcast.confirmPaste' : 'terminal.pasteWarning.title')}
        description={t('terminal.pasteWarning.description', {
          lines: pendingPaste ? pendingPaste.text.split(/\r\n|\r|\n/).length : 0,
          characters: pendingPaste?.text.length ?? 0,
        })}
        confirmLabel={t('terminal.pasteWarning.confirm')}
        confirmVariant={pendingPaste?.targets.length ? 'warning' : 'default'}
        media={pendingPaste?.targets.length ? <RadioTowerIcon /> : undefined}
        mediaVariant={pendingPaste?.targets.length ? 'warning' : 'default'}
        onConfirm={() => {
          const pending = pendingPaste;
          setPendingPaste(null);
          if (!pending) return;
          const target = terminalRegistry.get(pending.sessionId);
          const targetSession = useTerminalStore.getState().sessions.find((session) => session.sessionId === pending.sessionId);
          if (!target || targetSession?.status !== 'connected'
            || targetSession.pendingConnection
            || targetSession.readOnly
            || terminalInputReadiness.isPreparing(pending.sessionId)
            || agentTerminalLeaseState.blocksUserInput(pending.sessionId, targetSession.foregroundHandoffActive)) {
            showError(t('terminal.feedback.pasteUnavailable'));
          } else if (pending.targets.length) {
            const current = getTerminalBroadcastTargets(pending.sessionId);
            if (current.length !== pending.targets.length || current.some((id) => !pending.targets.includes(id))) {
              showError(t('terminal.broadcast.targetsChanged'));
            } else target.pasteUserText(pending.text, true);
          } else target.terminal.paste(pending.text);
        }}
      >
        {Boolean(pendingPaste?.targets.length) && (
          <Alert variant="warning" size="sm">
            <RadioTowerIcon />
            <AlertDescription>
              {t('terminal.broadcast.pasteTargets', { count: (pendingPaste?.targets.length ?? 0) + 1 })}
            </AlertDescription>
          </Alert>
        )}
        {pendingPaste && (
          <TerminalPastePreview
            text={pendingPaste.text}
            target={pendingPaste.target}
            broadcastTargets={pendingPaste.targets.length ? pendingPaste.targetLabels : undefined}
          />
        )}
      </ConfirmationDialog>
    </div>
  );
};
