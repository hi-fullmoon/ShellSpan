import { useCallback, useEffect, useMemo } from 'react';
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { SettingsPanel } from './components/SettingsPanel';
import { initI18n, syncI18nLocale, t } from './lib/i18n';
import { useLocalStorage } from './hooks/useLocalStorage';
import { isTauriRuntime } from './lib/tauri';
import type { AppPreferences, Snippet } from './types';

const IS_MAC = /mac/i.test(navigator.platform);

const defaultPreferences: AppPreferences = {
  theme: 'dark',
  locale: 'zh-CN',
  terminalFontSize: 14,
  terminalLineHeight: 1.2,
  terminalTheme: 'default',
  cursorStyle: 'block',
  cursorBlink: true,
  copyOnSelect: false,
  showFileManager: true,
  showSidebar: true,
  autoReconnect: true,
  startupUpdateCheck: true,
  historyLimit: 8,
  keyboardShortcuts: {},
};

const validTerminalThemes: Array<AppPreferences['terminalTheme']> = [
  'default',
  'dracula',
  'solarized-dark',
  'solarized-light',
  'one-dark',
  'monokai',
];
const validCursorStyles: Array<AppPreferences['cursorStyle']> = ['block', 'line', 'bar'];

function normalizePreferences(value: Partial<AppPreferences> | null | undefined): AppPreferences {
  return {
    theme: value?.theme === 'light' || value?.theme === 'system' ? value.theme : 'dark',
    locale: value?.locale === 'en-US' ? 'en-US' : 'zh-CN',
    terminalFontSize:
      typeof value?.terminalFontSize === 'number' && value.terminalFontSize >= 10 && value.terminalFontSize <= 20 ? value.terminalFontSize : 14,
    terminalLineHeight:
      typeof value?.terminalLineHeight === 'number' && value.terminalLineHeight >= 1 && value.terminalLineHeight <= 2
        ? value.terminalLineHeight
        : 1.2,
    terminalTheme: validTerminalThemes.includes(value?.terminalTheme as AppPreferences['terminalTheme'])
      ? (value!.terminalTheme as AppPreferences['terminalTheme'])
      : 'default',
    cursorStyle: validCursorStyles.includes(value?.cursorStyle as AppPreferences['cursorStyle'])
      ? (value!.cursorStyle as AppPreferences['cursorStyle'])
      : 'block',
    cursorBlink: value?.cursorBlink !== false,
    copyOnSelect: value?.copyOnSelect === true,
    showFileManager: value?.showFileManager !== false,
    showSidebar: value?.showSidebar !== false,
    autoReconnect: value?.autoReconnect !== false,
    startupUpdateCheck: value?.startupUpdateCheck !== false,
    historyLimit: typeof value?.historyLimit === 'number' && value.historyLimit >= 3 && value.historyLimit <= 20 ? value.historyLimit : 8,
    keyboardShortcuts: value?.keyboardShortcuts ?? {},
  };
}

function getSystemThemeMode() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark' as const;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? ('dark' as const) : ('light' as const);
}

const SETTINGS_CHANGED_EVENT = 'settings-changed';

function readLocalStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // ignore
  }
  return fallback;
}

export default function SettingsWindow() {
  const [storedPreferences, setStoredPreferences] = useLocalStorage<Partial<AppPreferences>>('termbridge.preferences', defaultPreferences);
  const [storedSnippets, setStoredSnippets] = useLocalStorage<Snippet[]>('termbridge.snippets', []);
  const preferences = useMemo(() => normalizePreferences(storedPreferences), [storedPreferences]);
  const appliedTheme = preferences.theme === 'system' ? getSystemThemeMode() : preferences.theme;
  // Initialize i18n
  useEffect(() => {
    syncI18nLocale(preferences.locale);
    void initI18n(preferences.locale);
  }, [preferences.locale]);

  // Apply theme
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = appliedTheme;
    }
  }, [appliedTheme]);

  // Listen for main window to refresh us (in case main changes something)
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    const attach = async () => {
      unlisten = await listen(SETTINGS_CHANGED_EVENT, () => {
        // Re-read localStorage to sync with main window changes
        const prefs = readLocalStorage<Partial<AppPreferences>>('termbridge.preferences', defaultPreferences);
        const snippets = readLocalStorage<Snippet[]>('termbridge.snippets', []);
        setStoredPreferences(prefs);
        setStoredSnippets(snippets);
      });
    };
    void attach();
    return () => {
      unlisten?.();
    };
  }, [setStoredPreferences, setStoredSnippets]);

  const handleChange = useCallback(
    (nextPreferences: AppPreferences) => {
      window.localStorage.setItem('termbridge.preferences', JSON.stringify(nextPreferences));
      setStoredPreferences(nextPreferences);
      void emitTo('main', SETTINGS_CHANGED_EVENT, {});
    },
    [setStoredPreferences],
  );

  const handleAddSnippet = useCallback(
    (name: string, command: string) => {
      const trimmedName = name.trim();
      const trimmedCommand = command.trim();
      if (!trimmedName || !trimmedCommand) return;
      const next = [
        ...storedSnippets,
        { id: `snippet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name: trimmedName, command: trimmedCommand },
      ];
      window.localStorage.setItem('termbridge.snippets', JSON.stringify(next));
      setStoredSnippets(next);
      void emitTo('main', SETTINGS_CHANGED_EVENT, {});
    },
    [storedSnippets, setStoredSnippets],
  );

  const handleUpdateSnippet = useCallback(
    (id: string, name: string, command: string) => {
      const trimmedName = name.trim();
      const trimmedCommand = command.trim();
      if (!trimmedName || !trimmedCommand) return;
      const next = storedSnippets.map((s) => (s.id === id ? { ...s, name: trimmedName, command: trimmedCommand } : s));
      window.localStorage.setItem('termbridge.snippets', JSON.stringify(next));
      setStoredSnippets(next);
      void emitTo('main', SETTINGS_CHANGED_EVENT, {});
    },
    [storedSnippets, setStoredSnippets],
  );

  const handleDeleteSnippet = useCallback(
    (id: string) => {
      const next = storedSnippets.filter((s) => s.id !== id);
      window.localStorage.setItem('termbridge.snippets', JSON.stringify(next));
      setStoredSnippets(next);
      void emitTo('main', SETTINGS_CHANGED_EVENT, {});
    },
    [storedSnippets, setStoredSnippets],
  );

  const handleMoveSnippet = useCallback(
    (id: string, direction: 'up' | 'down') => {
      const index = storedSnippets.findIndex((s) => s.id === id);
      if (index === -1) return;
      const next = [...storedSnippets];
      if (direction === 'up' && index > 0) {
        [next[index], next[index - 1]] = [next[index - 1], next[index]];
      } else if (direction === 'down' && index < next.length - 1) {
        [next[index], next[index + 1]] = [next[index + 1], next[index]];
      }
      window.localStorage.setItem('termbridge.snippets', JSON.stringify(next));
      setStoredSnippets(next);
      void emitTo('main', SETTINGS_CHANGED_EVENT, {});
    },
    [storedSnippets, setStoredSnippets],
  );

  const isTauri = isTauriRuntime();

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-(--app-bg) text-(--app-text)">
      {isTauri && IS_MAC && (
        <div className="settings-title-bar" data-tauri-drag-region>
          <div className="settings-title-bar-left" data-tauri-drag-region />
          <div className="settings-title-bar-center" data-tauri-drag-region>
            <span className="settings-title-bar-text" data-tauri-drag-region>{t('settings.title')}</span>
          </div>
          <div className="settings-title-bar-right" data-tauri-drag-region />
        </div>
      )}
      <SettingsPanel
        onAddSnippet={handleAddSnippet}
        onChange={handleChange}
        onDeleteSnippet={handleDeleteSnippet}
        onMoveSnippet={handleMoveSnippet}
        onUpdateSnippet={handleUpdateSnippet}
        preferences={preferences}
        snippets={storedSnippets}
      />
    </div>
  );
}
