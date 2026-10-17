import React, { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { useReconnectSession } from '@/hooks/useReconnectSession';
import { readClipboardText } from '@/lib/clipboard';
import { invokeOpenUrl, invokeRevealPath } from '@/lib/ipc/tauri';
import { openHostPath } from '@/lib/host/host-quick-actions';
import { getPlatform } from '@/lib/platform';
import { getShortcutKeys } from '@/lib/shortcuts';
import { parentDirectoryPath } from '@/lib/sftp/sftp-utils';
import { useAppStore, DEFAULT_SHORTCUTS } from '@/stores/appStore';
import { useAiDraftStore } from '@/stores/aiDraftStore';
import { useAiPanelStore } from '@/stores/aiPanelStore';
import { useFocusStore } from '@/stores/focusStore';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import { copyTerminalText } from './terminal-clipboard';
import { findHttpLinksInBuffer, terminalRegistry } from './registry/terminal-registry';
import { terminalInputReadiness } from './terminal-input-readiness';
import { agentTerminalLeaseState } from './agent-terminal-lease-state';

export function wantsTerminalMenu(terminal: Terminal, shiftKey: boolean): boolean {
  return shiftKey || terminal.modes.mouseTrackingMode === 'none';
}

export function clearTerminalScreen(terminal: Terminal): void {
  // Preserve the shell's cursor position as well as its scrollback.
  terminal.write('\u001b[2J');
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
  const line = terminal.buffer.active.getLine(row - 1);
  let start = column - 1;
  let end = column - 1;
  const character = (index: number): string => line?.getCell(index)?.getChars() ?? '';
  while (start > 0 && !/\s/.test(character(start - 1))) start--;
  while (end < terminal.cols && !/\s/.test(character(end))) end++;
  const word = line?.translateToString(true, start, end) ?? '';
  const selection = terminal.getSelection();
  const selected = terminal.getSelectionPosition();
  const withinSelection = selected && row - 1 >= selected.start.y && row - 1 <= selected.end.y
    && (row - 1 > selected.start.y || column - 1 >= selected.start.x)
    && (row - 1 < selected.end.y || column - 1 < selected.end.x);
  const candidate = withinSelection && selection && !/[\r\n]/.test(selection) ? selection : word;
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)[^\u0000-\u001f\u007f]+$/u.test(candidate) ? { path: candidate } : {};
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
  const { error: showError } = useToast();
  const reconnect = useReconnectSession();
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState({ selection: '', url: undefined as string | undefined, path: undefined as string | undefined });
  const [clipboard, setClipboard] = useState<string | null>(null);
  const [clearTarget, setClearTarget] = useState<Terminal | null>(null);
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
    mounted.current = true;
    return () => { mounted.current = false; opening.current++; };
  }, [sessionId, terminal]);

  const valid = (): boolean => Boolean(mounted.current && currentTerminal.current === terminal && sessionId && terminal && terminalRegistry.get(sessionId)?.terminal === terminal
    && useTerminalStore.getState().sessions.some(item => item.sessionId === sessionId));
  const connected = session?.status === 'connected';
  const canPaste = connected && !terminalInputReadiness.isPreparing(sessionId ?? null)
    && !agentTerminalLeaseState.get(sessionId ?? null);
  const shortcuts = useAppStore(state => state.shortcuts);
  const mac = getPlatform() === 'macos';
  const hint = (value: string): React.ReactNode => <span className="ml-auto pl-4 text-muted-foreground">{value}</span>;
  const copy = (text: string): void => { void copyTerminalText(text); };
  const run = (action: () => void): void => { if (valid()) action(); };
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
      <ContextMenuContent aria-label={t('terminal.menu.label')} finalFocus={() =>
        restoreFocus.current && valid() ? terminal?.textarea : false}>
        <ContextMenuGroup>
          <ContextMenuItem disabled={!snapshot.selection} onClick={() => {
            const text = useAppStore.getState().terminalTrimTrailingWhitespace ? snapshot.selection.replace(/[ \t]+(?=\r?$)/gm, '') : snapshot.selection;
            copy(text);
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
        {(snapshot.url || snapshot.path) && <><ContextMenuSeparator /><ContextMenuGroup>
          {snapshot.url && <>
            <ContextMenuItem onClick={() => { void invokeOpenUrl(snapshot.url!).catch(() => showError(t('ai.link.openFailed'))); }}>{t('ai.link.open')}</ContextMenuItem>
            <ContextMenuItem onClick={() => copy(snapshot.url!)}>{t('ai.link.copyAddress')}</ContextMenuItem>
          </>}
          {snapshot.path && <>
            <ContextMenuItem onClick={() => run(() => {
              restoreFocus.current = false;
              if (session?.host === 'local' && session.port === 0) {
                void invokeRevealPath(snapshot.path!).catch(() => showError(t('ai.path.revealFailed')));
              } else {
                const profile = useProfileStore.getState().profiles.find(item => item.id === session?.profileId);
                if (profile) openHostPath(profile, parentDirectoryPath(snapshot.path!), 'sftp');
              }
            })} disabled={!(session?.host === 'local' && session.port === 0) && !session?.profileId}>{t('terminal.menu.revealPath')}</ContextMenuItem>
            <ContextMenuItem onClick={() => copy(snapshot.path!)}>{t('ai.path.copy')}</ContextMenuItem>
          </>}
        </ContextMenuGroup></>}
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => run(() => { restoreFocus.current = false; onSearch(); })}>{t('terminal.menu.find')}{hint(getShortcutKeys(shortcuts.findTerminal ?? DEFAULT_SHORTCUTS.findTerminal, getPlatform()).join('+'))}</ContextMenuItem>
          <ContextMenuItem disabled={!terminal || terminal.buffer.active.viewportY >= terminal.buffer.active.baseY} onClick={() => run(() => terminal?.scrollToBottom())}>{t('terminal.menu.scrollBottom')}</ContextMenuItem>
        </ContextMenuGroup>
        {snapshot.selection && <><ContextMenuSeparator /><ContextMenuGroup>
          <ContextMenuItem onClick={() => transfer(false)}>{t('terminal.menu.sendAi')}</ContextMenuItem>
          <ContextMenuItem onClick={() => transfer(true)}>{t('terminal.menu.analyzeAi')}</ContextMenuItem>
        </ContextMenuGroup></>}
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem disabled={!connected || terminal?.buffer.active.type !== 'normal'} onClick={() => run(() => { if (terminal) clearTerminalScreen(terminal); })}>{t('terminal.menu.clearScreen')}</ContextMenuItem>
          <ContextMenuItem disabled={terminal?.buffer.active.type !== 'normal' || !terminal?.buffer.normal.baseY} onClick={() => run(() => { restoreFocus.current = false; setClearTarget(terminal); })}>{t('terminal.menu.clearHistory')}</ContextMenuItem>
          {(session?.status === 'disconnected' || session?.status === 'error') && <ContextMenuItem onClick={() => run(() => { restoreFocus.current = false; void reconnect(sessionId!); })}>{t('terminal.menu.reconnect')}</ContextMenuItem>}
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
  </>;
}
