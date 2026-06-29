import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useLocalStorage } from './useLocalStorage';
import { createLogger } from '../lib/logger';
import { isTauriRuntime } from '../lib/tauri';
import { defaultPreferences, getSystemThemeMode, normalizePreferences } from '../lib/appHelpers';
import type { AppPreferences } from '../types';

const preferencesLogger = createLogger('app');

export interface UsePreferencesResult {
  storedPreferences: Partial<AppPreferences>;
  setStoredPreferences: Dispatch<SetStateAction<Partial<AppPreferences>>>;
  preferences: AppPreferences;
  appliedTheme: 'dark' | 'light';
  systemThemeMode: 'dark' | 'light';
}

export function usePreferences(): UsePreferencesResult {
  const [storedPreferences, setStoredPreferences] = useLocalStorage<Partial<AppPreferences>>('termbridge.preferences', defaultPreferences);
  const [systemThemeMode, setSystemThemeMode] = useState<'dark' | 'light'>(() => getSystemThemeMode());
  const preferences = useMemo(() => normalizePreferences(storedPreferences), [storedPreferences]);
  const appliedTheme = preferences.theme === 'system' ? systemThemeMode : preferences.theme;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const applySystemTheme = () => {
      setSystemThemeMode(darkMediaQuery.matches ? 'dark' : 'light');
    };

    applySystemTheme();
    if (typeof darkMediaQuery.addEventListener === 'function') {
      darkMediaQuery.addEventListener('change', applySystemTheme);
      return () => {
        darkMediaQuery.removeEventListener('change', applySystemTheme);
      };
    }

    darkMediaQuery.addListener(applySystemTheme);
    return () => {
      darkMediaQuery.removeListener(applySystemTheme);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = appliedTheme;
  }, [appliedTheme]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    try {
      void getCurrentWindow()
        .setTheme(preferences.theme === 'system' ? null : preferences.theme)
        .catch((error) => {
          preferencesLogger.warn('同步原生窗口主题失败', { error: String(error), theme: preferences.theme });
        });
    } catch (error) {
      preferencesLogger.warn('获取原生窗口实例失败，跳过窗口主题同步', { error: String(error), theme: preferences.theme });
    }
  }, [preferences.theme]);

  return { storedPreferences, setStoredPreferences, preferences, appliedTheme, systemThemeMode };
}
