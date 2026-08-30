import { useEffect } from 'react';
import {
  eventMatchesShortcut,
  isLeaderShortcutAction,
  SHORTCUT_SCOPES,
} from '@/lib/shortcuts';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import type { ShortcutAction } from '@/types';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAiStore } from '@/stores/aiStore';

// The leader binding and its sub-keys live in the terminal input layer
// (terminal-leader.ts), not at the document level.
const isDocumentLevelAction = (action: ShortcutAction): boolean =>
  action !== 'terminalLeader' && !isLeaderShortcutAction(action);

export function useAppShortcuts(): void {
  const shortcuts = useAppStore((state) => state.shortcuts);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return;

      const effectiveShortcuts = { ...DEFAULT_SHORTCUTS, ...shortcuts };
      const activeSection = useAppStore.getState().activeSection;

      // Scope eligibility is part of matching, not a post-check: two scoped
      // actions may share one chord (e.g. mod+k in terminal and sftp), and
      // only the one whose scope is active may win.
      const action = (Object.keys(effectiveShortcuts) as ShortcutAction[]).find(
        (candidate) => {
          if (!isDocumentLevelAction(candidate)) return false;
          const scope = SHORTCUT_SCOPES[candidate];
          if (scope === 'terminal' && activeSection !== 'terminal') return false;
          if (scope === 'sftp' && activeSection !== 'sftp') return false;
          return eventMatchesShortcut(event, effectiveShortcuts[candidate]);
        },
      );
      if (!action) return;

      if (
        SHORTCUT_SCOPES[action] !== 'global'
        && event.target instanceof Element
        && event.target.closest('[role="dialog"]')
      ) return;

      event.preventDefault();
      const { openSettings, setActiveSection } = useAppStore.getState();

      switch (action) {
        case 'openWorkbench':
          setActiveSection('workbench');
          break;
        case 'openTerminal':
          setActiveSection('terminal');
          break;
        case 'openSftp':
          setActiveSection('sftp');
          break;
        case 'openSettings':
          openSettings();
          break;
        case 'openCommandPalette':
          document.dispatchEvent(new Event('termbridge:open-command-palette'));
          break;
        case 'toggleAiPanel':
          useAiStore.getState().toggleOpen();
          break;
        case 'newTerminalTab':
          document.dispatchEvent(new Event('termbridge:new-terminal-tab'));
          break;
        case 'closeTerminalTab':
          document.dispatchEvent(new Event('termbridge:close-terminal-tab'));
          break;
        case 'switchTerminalTab':
          document.dispatchEvent(new Event('termbridge:switch-terminal-tab'));
          break;
        case 'findTerminal':
          document.dispatchEvent(new Event('termbridge:find-terminal'));
          break;
        case 'newSftpConnection':
          document.dispatchEvent(new Event('termbridge:new-sftp-connection'));
          break;
        case 'nextTerminalTab':
        case 'previousTerminalTab': {
          const terminal = useTerminalStore.getState();
          if (terminal.sessions.length < 2) break;
          const currentIndex = terminal.sessions.findIndex(
            (session) => session.sessionId === terminal.activeSessionId,
          );
          const direction = action === 'nextTerminalTab' ? 1 : -1;
          const nextIndex = (currentIndex + direction + terminal.sessions.length) % terminal.sessions.length;
          terminal.setActiveSession(terminal.sessions[nextIndex]?.sessionId ?? null);
          break;
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts]);
}
