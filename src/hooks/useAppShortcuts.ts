import { useEffect } from 'react';
import { eventMatchesShortcut } from '@/lib/shortcuts';
import { DEFAULT_SHORTCUTS, useAppStore } from '@/stores/appStore';
import type { ShortcutAction } from '@/types';
import { useTerminalStore } from '@/stores/terminalStore';

export function useAppShortcuts(): void {
  const shortcuts = useAppStore((state) => state.shortcuts);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return;

      const effectiveShortcuts = { ...DEFAULT_SHORTCUTS, ...shortcuts };

      const action = (Object.keys(effectiveShortcuts) as ShortcutAction[]).find((candidate) =>
        eventMatchesShortcut(event, effectiveShortcuts[candidate]),
      );
      if (!action) return;

      const terminalAction = [
        'newTerminalTab',
        'closeTerminalTab',
        'nextTerminalTab',
        'previousTerminalTab',
        'findTerminal',
      ].includes(action);
      if (terminalAction && useAppStore.getState().activeSection !== 'terminal') return;
      if (
        terminalAction &&
        event.target instanceof Element &&
        event.target.closest('[role="dialog"]')
      ) return;

      event.preventDefault();
      const { setActiveSection, setActiveWorkbenchTab } = useAppStore.getState();

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
          setActiveSection('workbench');
          setActiveWorkbenchTab('settings');
          break;
        case 'newTerminalTab':
          document.dispatchEvent(new Event('termbridge:new-terminal-tab'));
          break;
        case 'closeTerminalTab':
          document.dispatchEvent(new Event('termbridge:close-terminal-tab'));
          break;
        case 'findTerminal':
          document.dispatchEvent(new Event('termbridge:find-terminal'));
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
