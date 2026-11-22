import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Terminal } from '@xterm/xterm';
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from '@/components/ui/context-menu';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { useToastStore } from '@/stores/toastStore';
import { useReconnectSession } from '@/hooks/useReconnectSession';
import { readClipboardText, writeClipboardText } from '@/lib/clipboard';
import { invokeExportTerminalBuffer, invokeGetTerminalRecordingStatus, invokeOpenUrl, invokeRevealPath, isTauriRuntime,
  invokeStartTerminalRecording, invokeStopTerminalRecording, type TerminalExportFormat, type TerminalRecordingFormat } from '@/lib/ipc/tauri';
import { serializeTerminalBuffer } from '@/lib/terminal/terminal-buffer-export';
import { getPlatform } from '@/lib/platform';
import { getShortcutKeys } from '@/lib/shortcuts';
import { revealTerminalCurrentDirectory } from '@/lib/terminal/terminal-current-directory';
import { findFileLinksInLine, findHttpLinksInBuffer, findLinksInTerminalBuffer, openTerminalFileLink, parseTerminalFileLink } from '@/lib/terminal/terminal-links';
import { useAppStore, DEFAULT_SHORTCUTS } from '@/stores/appStore';
import { useAiDraftStore } from '@/stores/aiDraftStore';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useFocusStore } from '@/stores/focusStore';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import { terminalRegistry } from './registry/terminal-registry';
import { terminalInputReadiness } from './terminal-input-readiness';
import { agentTerminalLeaseState } from './agent-terminal-lease-state';

export function wantsTerminalMenu(terminal: Terminal, shiftKey: boolean): boolean {
  return shiftKey || terminal.modes.mouseTrackingMode === 'none';
}

export async function clearTerminalScreen(terminal: Terminal, sessionId: string): Promise<'requested' | 'unavailable' | 'blocked'> {
  // Inspect the buffer only after previously queued output has been parsed.
  await new Promise<void>(resolve => terminal.write('', resolve));
  const session = useTerminalStore.getState().sessions.find(item => item.sessionId === sessionId);
  const controller = terminalRegistry.get(sessionId);
  if (terminal.buffer.active.type !== 'normal' || controller?.terminal !== terminal || session?.status !== 'connected'
    || session.readOnly || terminalInputReadiness.isPreparing(sessionId) || agentTerminalLeaseState.blocksUserInput(sessionId)) return 'blocked';
  // Terminal cells do not identify an editing region. Guessing from isWrapped
  // loses hard newlines; restoring CUP also destroys the pending-wrap state.
  // Leave the entire emulator untouched when a shell cannot redraw safely.
  if (session.integrationState !== 'ready' || controller.hasUnconfirmedLineBreak()) return 'unavailable';
  if (!session.promptReady || controller.hasUnverifiedUserSubmission()) return 'blocked';
  // Let the shell redraw its full prompt and current editing buffer. Await the
  // production input path, including native ownership admission and IPC errors.
  if (!await controller.writeUserInput('\u000c')) return 'blocked';
  terminal.clearSelection();
  terminal.scrollToBottom();
  return 'requested';
}

/** Use xterm's public cell coordinates so wrapped links and wide glyphs stay accurate. */
export function terminalContextTarget(terminal: Terminal, x: number, y: number): { url?: string; path?: string } {
  const screen = terminal.element?.querySelector('.xterm-screen');
  const bounds = screen?.getBoundingClientRect();
  if (!bounds?.width || !bounds.height || x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) return {};
  const column = Math.floor((x - bounds.left) / bounds.width * terminal.cols) + 1;
  const row = Math.floor((y - bounds.top) / bounds.height * terminal.rows) + terminal.buffer.active.viewportY + 1;
  const link = findHttpLinksInBuffer(terminal.buffer.active, row, terminal.cols).find(({ range }) =>
    (row > range.start.y || column >= range.start.x) && (row < range.end.y || column <= range.end.x));
  if (link) return { url: link.text };
  const file = findLinksInTerminalBuffer(terminal.buffer.active, row, terminal.cols, findFileLinksInLine).find(({ range }) =>
    (row > range.start.y || column >= range.start.x) && (row < range.end.y || column <= range.end.x));
  const selection = terminal.getSelection();
  const selected = terminal.getSelectionPosition();
  const withinSelection = selected && row - 1 >= selected.start.y && row - 1 <= selected.end.y
    && (row - 1 > selected.start.y || column - 1 >= selected.start.x)
    && (row - 1 < selected.end.y || column - 1 < selected.end.x);
  let candidate = selection;
  if (!withinSelection || !selection || /[\r\n]/.test(selection)) {
    if (file) return { path: file.text };
    const buffer = terminal.buffer.active;
    const line = buffer.getLine(row - 1);
    if (!line) return {};
    const reusableCell = buffer.getNullCell();
    const isBlank = (index: number): boolean => {
      const cell = line.getCell(index, reusableCell);
      if (!cell) return true;
      const chars = cell.getChars();
      return cell.getWidth() !== 0 && (!chars || /\s/.test(chars));
    };
    let start = column - 1;
    let end = column;
    if (isBlank(start)) return {};
    while (start > 0 && !isBlank(start - 1)) start--;
    while (end < terminal.cols && !isBlank(end)) end++;
    candidate = line.translateToString(true, start, end);
  }
  return parseTerminalFileLink(candidate) ? { path: candidate } : {};
}

interface Props {
  session: TerminalSession | null;
  terminal: Terminal | null;
  onPaste: (text: string) => void;
  onSearch: () => void;
  children: React.ReactElement;
}

export function TerminalContentMenu({ session, terminal, onPaste, onSearch, children }: Props) {
  const { t } = useI18n();
  const { error: showError, success: showSuccess } = useToast();
  const reconnect = useReconnectSession();
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState({ selection: '', url: undefined as string | undefined, path: undefined as string | undefined });
  const { selection, url, path } = snapshot;
  const [clipboard, setClipboard] = useState<string | null>(null);
  const [clearTarget, setClearTarget] = useState<Terminal | null>(null);
  const [reconnectConfirmSessionId, setReconnectConfirmSessionId] = useState<string | null>(null);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const opening = useRef(0);
  const mounted = useRef(true);
  const currentTerminal = useRef(terminal);
  currentTerminal.current = terminal;
  const restoreFocus = useRef(true);
  const sessionId = session?.sessionId;
  useEffect(() => {
    opening.current++;
    setOpen(false);
    setClearTarget(null);
    setReconnectConfirmSessionId(null);
    mounted.current = true;
    return () => { mounted.current = false; opening.current++; };
  }, [sessionId, terminal]);

  const valid = (): boolean => Boolean(mounted.current && currentTerminal.current === terminal && sessionId && terminal && terminalRegistry.get(sessionId)?.terminal === terminal
    && useTerminalStore.getState().sessions.some(item => item.sessionId === sessionId));
  const connected = session?.status === 'connected';
  const hasProfile = useProfileStore((state) => !session?.profileId || state.profiles.some((p) => p.id === session.profileId));
  const canReconnect = Boolean(session)
    && !session?.reconnecting
    && !session?.pendingConnection
    && session?.status !== 'connecting'
    && hasProfile;
  const preparing = useSyncExternalStore(terminalInputReadiness.subscribe, () => terminalInputReadiness.isPreparing(sessionId ?? null));
  const lease = useSyncExternalStore(agentTerminalLeaseState.subscribe, () => agentTerminalLeaseState.get(sessionId ?? null));
  const canPaste = connected && !session?.readOnly && !preparing && (!lease || lease.waitingForUserAction || session?.foregroundHandoffActive);
  useEffect(() => {
    if (!open || !sessionId || !connected || !isTauriRuntime()) return;
    let current = true;
    void invokeGetTerminalRecordingStatus(sessionId).then((status) => {
      if (current) useTerminalStore.getState().setRecording(sessionId, status ?? undefined);
    }).catch(() => {});
    return () => { current = false; };
  }, [open, sessionId, connected]);
  const shortcuts = useAppStore(state => state.shortcuts);
  const mac = getPlatform() === 'macos';
  const hint = (value: string): React.ReactNode => <span className="ml-auto pl-4 text-muted-foreground">{value}</span>;
  const run = (action: () => void): void => { if (valid()) action(); };
  const copyText = (text: string): void => run(() => {
    void writeClipboardText(text).catch(() => showError(t('terminal.feedback.copyFailed')));
  });
  const exportOutput = (format: TerminalExportFormat): void => run(() => {
    if (!terminal) return;
    void serializeTerminalBuffer(terminal, format).then((content) => invokeExportTerminalBuffer(format, content))
      .then((path) => { if (path) showSuccess(t('terminal.recording.exported')); })
      .catch(() => showError(t('terminal.recording.exportFailed')));
  });
  const changeRecording = (format?: TerminalRecordingFormat): void => run(() => {
    if (!sessionId || !terminal || recordingBusy) return;
    setRecordingBusy(true);
    const request = format ? invokeStartTerminalRecording(sessionId, format, terminal.cols, terminal.rows)
      : invokeStopTerminalRecording(sessionId);
    void request.then((status) => {
      if (format && !status) return;
      useTerminalStore.getState().setRecording(sessionId, status?.active ? status : undefined);
      if (!format && status) {
        useToastStore.getState().addToast(
          status.droppedFrames > 0
            ? t('terminal.recording.stopped', { dropped: status.droppedFrames })
            : t('terminal.recording.stoppedClean'),
          'success',
          undefined,
          {
            label: t('terminal.recording.reveal'),
            onClick: () => {
              void invokeRevealPath(status.path).catch(() => showError(t('ai.path.revealFailed')));
            },
          },
        );
      }
    }).catch(() => {
      if (!format) useTerminalStore.getState().setRecording(sessionId);
      showError(t('terminal.recording.failed'));
    }).finally(() => setRecordingBusy(false));
  });
  const transfer = (analyze: boolean): void => run(() => {
    if (!snapshot.selection || !sessionId) return;
    restoreFocus.current = false;
    const focus = useFocusStore.getState().enabled;
    const text = `${analyze ? `${t('terminal.menu.analysisPrompt')}\n\n` : ''}${t('terminal.menu.source', { target: session?.title ?? '' })}\n${snapshot.selection}`;
    useAiDraftStore.getState().insertTerminalText(`${focus ? 'focus' : 'terminal'}:${sessionId}`, text);
    if (!focus) useTerminalStore.getState().setActiveSession(sessionId);
    useAiPanelStore.getState().setOpen(true, 'terminal');
  });

  return <>
    <ContextMenu open={open} onOpenChange={setOpen}>
      <ContextMenuTrigger render={children}
        onMouseDownCapture={event => {
          if (terminal && event.button === 2 && wantsTerminalMenu(terminal, event.shiftKey)) event.stopPropagation();
        }}
        onContextMenu={event => {
          if (!terminal || !session || !wantsTerminalMenu(terminal, event.shiftKey)) {
            event.preventDefault();
            event.preventBaseUIHandler();
            return;
          }
          restoreFocus.current = true;
          setSnapshot({ selection: terminal.getSelection(), url: undefined, path: undefined,
            ...terminalContextTarget(terminal, event.clientX, event.clientY) });
          setClipboard(null);
          const generation = ++opening.current;
          void readClipboardText().then(text => {
            if (generation === opening.current) setClipboard(text);
          }).catch(() => {});
        }} />
      <ContextMenuContent
        aria-label={t('terminal.menu.label')}
        className="focus-visible:outline-hidden! [&_[role=menuitem]:focus-visible]:outline-hidden!"
        finalFocus={() => restoreFocus.current && valid() ? terminal?.textarea : false}
      >
        <ContextMenuGroup>
          <ContextMenuItem disabled={!selection} label={t('common.copy')} aria-label={t('common.copy')} onClick={() => {
            const trim = useAppStore.getState().terminalTrimTrailingWhitespace;
            copyText(trim ? selection.replace(/[ \t]+(?=\r?$)/gm, '') : selection);
          }}>{t('common.copy')}{hint(mac ? '⌘+C' : 'Ctrl+Shift+C')}</ContextMenuItem>
          <ContextMenuItem disabled={!canPaste || clipboard === ''} onClick={() => run(() => {
            if (clipboard !== null) onPaste(clipboard);
            else {
              const generation = opening.current;
              void readClipboardText().then(text => {
                if (valid() && opening.current === generation) onPaste(text);
              }).catch(() => showError(t('terminal.feedback.pasteFailed')));
            }
          })}>{t('terminal.menu.paste')}{hint(mac ? '⌘+V' : 'Ctrl+Shift+V')}</ContextMenuItem>
          <ContextMenuItem disabled={!terminal?.buffer.active.length} onClick={() => run(() => terminal?.selectAll())}>{t('terminal.menu.selectAll')}</ContextMenuItem>
        </ContextMenuGroup>
        {(url || path) && <><ContextMenuSeparator /><ContextMenuGroup>
          {url && <>
            <ContextMenuItem onClick={() => { void invokeOpenUrl(url).catch(() => showError(t('ai.link.openFailed'))); }}>{t('ai.link.open')}</ContextMenuItem>
            <ContextMenuItem onClick={() => copyText(url)}>{t('ai.link.copyAddress')}</ContextMenuItem>
          </>}
          {path && <>
            <ContextMenuItem onClick={() => run(() => {
              restoreFocus.current = false;
              if (session) void openTerminalFileLink(session, path).then((opened) => {
                if (!opened) showError(t('ai.path.revealFailed'));
              }).catch(() => showError(t('ai.path.revealFailed')));
            })} disabled={!(session?.host === 'local' && session.port === 0) && !session?.profileId}>{t('terminal.menu.revealPath')}</ContextMenuItem>
            <ContextMenuItem onClick={() => copyText(parseTerminalFileLink(path)?.path ?? path)}>{t('ai.path.copy')}</ContextMenuItem>
          </>}
        </ContextMenuGroup></>}
        <ContextMenuSeparator />
        <ContextMenuGroup>
          {session?.host === 'local' && session.port === 0 && <ContextMenuItem disabled={!connected} onClick={() => run(() => {
            void revealTerminalCurrentDirectory(session.sessionId).then((opened) => {
              if (!opened) showError(t('terminal.menu.noCurrentDirectory'));
            }).catch(() => showError(t('ai.path.revealFailed')));
          })}>{t('terminal.menu.revealCurrentDirectory')}</ContextMenuItem>}
          <ContextMenuItem onClick={() => run(() => { restoreFocus.current = false; onSearch(); })}>{t('terminal.menu.find')}{hint(getShortcutKeys(shortcuts.findTerminal ?? DEFAULT_SHORTCUTS.findTerminal, getPlatform()).join('+'))}</ContextMenuItem>
          <ContextMenuItem disabled={!terminal || terminal.buffer.active.viewportY >= terminal.buffer.active.baseY} onClick={() => run(() => terminal?.scrollToBottom())}>{t('terminal.menu.scrollBottom')}</ContextMenuItem>
        </ContextMenuGroup>
        {snapshot.selection && <><ContextMenuSeparator /><ContextMenuGroup>
          <ContextMenuItem onClick={() => transfer(false)}>{t('terminal.menu.sendAi')}</ContextMenuItem>
          <ContextMenuItem onClick={() => transfer(true)}>{t('terminal.menu.analyzeAi')}</ContextMenuItem>
        </ContextMenuGroup></>}
        <ContextMenuSeparator />
        <ContextMenuGroup>
          {session?.recording && (
            <ContextMenuItem disabled={recordingBusy} onClick={() => changeRecording()}>
              {t('terminal.recording.stop')}
            </ContextMenuItem>
          )}
          <ContextMenuSub>
            <ContextMenuSubTrigger>{t('terminal.recording.submenu')}</ContextMenuSubTrigger>
            <ContextMenuSubContent className="focus-visible:outline-hidden! [&_[role=menuitem]:focus-visible]:outline-hidden!">
              <ContextMenuGroup>
                <ContextMenuItem onClick={() => exportOutput('text')}>{t('terminal.recording.exportText')}</ContextMenuItem>
                <ContextMenuItem onClick={() => exportOutput('ansi')}>{t('terminal.recording.exportAnsi')}</ContextMenuItem>
              </ContextMenuGroup>
              <ContextMenuSeparator />
              <ContextMenuGroup>
                {session?.recording ? (
                  <ContextMenuItem disabled={recordingBusy} onClick={() => changeRecording()}>
                    {t('terminal.recording.stop')}
                  </ContextMenuItem>
                ) : (
                  <>
                    <ContextMenuItem disabled={!connected || recordingBusy} onClick={() => changeRecording('plain-log')}>
                      {t('terminal.recording.startLog')}
                    </ContextMenuItem>
                    <ContextMenuItem disabled={!connected || recordingBusy} onClick={() => changeRecording('asciinema-v2')}>
                      {t('terminal.recording.startCast')}
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => run(() => {
            if (sessionId) useTerminalStore.getState().toggleReadOnly(sessionId);
          })}>{t(session?.readOnly ? 'terminal.inputLock.unlock' : 'terminal.inputLock.lock')}</ContextMenuItem>
          <ContextMenuItem disabled={!canPaste || terminal?.buffer.active.type !== 'normal' || (session?.integrationState === 'ready' && !session.promptReady)} onClick={() => run(() => {
            if (terminal && sessionId) void clearTerminalScreen(terminal, sessionId).then(result => {
              if (result !== 'requested' && valid()) showError(t(result === 'unavailable' ? 'terminal.menu.clearUnavailable' : 'terminal.menu.clearBlocked'));
            }).catch(() => { if (valid()) showError(t('terminal.notice.writeFailedLabel')); });
          })}>{t('terminal.menu.clearScreen')}</ContextMenuItem>
          <ContextMenuItem disabled={terminal?.buffer.active.type !== 'normal' || !terminal?.buffer.normal.baseY} onClick={() => run(() => { restoreFocus.current = false; setClearTarget(terminal); })}>{t('terminal.menu.clearHistory')}</ContextMenuItem>
          <ContextMenuItem disabled={!canReconnect} onClick={() => run(() => {
            if (!sessionId) return;
            if (agentTerminalLeaseState.get(sessionId)) {
              restoreFocus.current = false;
              setReconnectConfirmSessionId(sessionId);
              return;
            }
            void reconnect(sessionId, false, { resetBuffer: true });
          })}>{t('terminal.menu.reconnect')}</ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
    <ConfirmationDialog open={Boolean(clearTarget)} onOpenChange={next => { if (!next) setClearTarget(null); }}
      title={t('terminal.menu.clearHistory')} description={t('terminal.menu.clearHistoryDescription')}
      confirmLabel={t('common.confirm')} onConfirm={() => {
        if (valid() && terminal === clearTarget) terminal?.write('\u001b[3J');
        setClearTarget(null);
        terminal?.focus();
      }} />
    <ConfirmationDialog
      open={Boolean(reconnectConfirmSessionId)}
      onOpenChange={next => { if (!next) setReconnectConfirmSessionId(null); }}
      title={t('terminal.menu.reconnectConfirmTitle')}
      description={t('terminal.menu.reconnectConfirmDescription')}
      confirmLabel={t('terminal.menu.reconnect')}
      confirmVariant="destructive"
      onConfirm={() => {
        const targetId = reconnectConfirmSessionId;
        setReconnectConfirmSessionId(null);
        if (targetId) void reconnect(targetId, false, { resetBuffer: true });
      }}
    />
  </>;
}
