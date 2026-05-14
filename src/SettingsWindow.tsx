import { useCallback, useEffect, useMemo, useState } from 'react';
import { emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { SettingsPanel } from './components/SettingsPanel';
import { initI18n, syncI18nLocale, t } from './lib/i18n';
import { isTauriRuntime } from './lib/tauri';
import type { AppPreferences } from './types';

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
const PREFERENCES_STORAGE_KEY = 'termbridge.preferences';

function readLocalStorage<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // ignore
  }
  return fallback;
}

function readLaunchPreferences(): Partial<AppPreferences> {
  if (typeof window === 'undefined') {
    return {};
  }

  const params = new URLSearchParams(window.location.search);
  const locale = params.get('locale');
  const theme = params.get('theme');

  return {
    ...(locale === 'en-US' || locale === 'zh-CN' ? { locale } : {}),
    ...(theme === 'dark' || theme === 'light' || theme === 'system' ? { theme } : {}),
  };
}

function readInitialPreferences() {
  return {
    ...readLocalStorage<Partial<AppPreferences>>(PREFERENCES_STORAGE_KEY, defaultPreferences),
    ...readLaunchPreferences(),
  };
}

export default function SettingsWindow() {
  const [storedPreferences, setStoredPreferences] = useState<Partial<AppPreferences>>(() => readInitialPreferences());
  const preferences = useMemo(() => normalizePreferences(storedPreferences), [storedPreferences]);
  const appliedTheme = preferences.theme === 'system' ? getSystemThemeMode() : preferences.theme;
  // Sync locale before first render so t() returns correct translations immediately
  syncI18nLocale(preferences.locale);
  // Initialize i18n asynchronously (intl.init is async)
  useEffect(() => {
    void initI18n(preferences.locale);
  }, [preferences.locale]);

  // Apply theme
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = appliedTheme;
    }
  }, [appliedTheme]);

  useEffect(() => {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(storedPreferences));
  }, [storedPreferences]);

  // Listen for main window to refresh us (in case main changes something)
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    const attach = async () => {
      unlisten = await listen(SETTINGS_CHANGED_EVENT, () => {
        // Re-read localStorage to sync with main window changes
        const prefs = readLocalStorage<Partial<AppPreferences>>(PREFERENCES_STORAGE_KEY, defaultPreferences);
        setStoredPreferences(prefs);
      });
    };
    void attach();
    return () => {
      unlisten?.();
    };
  }, [setStoredPreferences]);

  const handleChange = useCallback(
    (nextPreferences: AppPreferences) => {
      window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(nextPreferences));
      setStoredPreferences(nextPreferences);
      void emitTo('main', SETTINGS_CHANGED_EVENT, {});
    },
    [setStoredPreferences],
  );

  const isTauri = isTauriRuntime();

  const handleMinimize = useCallback(() => {
    if (isTauri) void getCurrentWindow().minimize();
  }, [isTauri]);

  const handleClose = useCallback(() => {
    if (isTauri) void getCurrentWindow().close();
  }, [isTauri]);

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
      {isTauri && !IS_MAC && (
        <div className="settings-title-bar" data-tauri-drag-region>
          <div className="settings-title-bar-left !pl-0" data-tauri-drag-region />
          <div className="settings-title-bar-center" data-tauri-drag-region>
            <span className="settings-title-bar-text" data-tauri-drag-region>{t('settings.title')}</span>
          </div>
          <div className="settings-title-bar-right settings-title-bar-controls" data-tauri-drag-region>
            <button
              aria-label="Minimize"
              className="settings-window-btn settings-window-btn-minimize"
              onClick={handleMinimize}
              type="button"
            >
              <svg fill="none" height="10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" viewBox="0 0 10 10" width="10">
                <path d="M1 5h8" />
              </svg>
            </button>
            <button
              aria-label="Close"
              className="settings-window-btn settings-window-btn-close"
              onClick={handleClose}
              type="button"
            >
              <svg fill="none" height="10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" viewBox="0 0 10 10" width="10">
                <path d="m2 2 6 6" />
                <path d="m8 2-6 6" />
              </svg>
            </button>
          </div>
        </div>
      )}
      <SettingsPanel
        onChange={handleChange}
        preferences={preferences}
      />
    </div>
  );
}
