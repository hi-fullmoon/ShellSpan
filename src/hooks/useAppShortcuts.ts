import { useEffect } from 'react';
import { eventMatchesShortcut } from '@/lib/shortcuts';
import { useAppStore } from '@/stores/appStore';
import type { ShortcutAction } from '@/types';

export function useAppShortcuts(): void {
  const shortcuts = useAppStore((state) => state.shortcuts);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return;

      const action = (Object.keys(shortcuts) as ShortcutAction[]).find((candidate) =>
        eventMatchesShortcut(event, shortcuts[candidate]),
      );
      if (!action) return;

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
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts]);
}
