import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createLogger } from '../lib/logger';
import { getSystemThemeMode } from '../lib/appHelpers';
import { isTauriRuntime } from '../lib/tauri';
import type { ThemePreference } from '../types';

const appliedThemeLogger = createLogger('useAppliedTheme');

export interface UseAppliedThemeResult {
  appliedTheme: 'dark' | 'light';
  systemThemeMode: 'dark' | 'light';
}

export function useAppliedTheme(themePreference: ThemePreference): UseAppliedThemeResult {
  const [systemThemeMode, setSystemThemeMode] = useState<'dark' | 'light'>(() => getSystemThemeMode());

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

  const appliedTheme = themePreference === 'system' ? systemThemeMode : themePreference;

  useEffect(() => {
    document.documentElement.dataset.theme = appliedTheme;
  }, [appliedTheme]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    try {
      void getCurrentWindow()
        .setTheme(themePreference === 'system' ? null : themePreference)
        .catch((error) => {
          appliedThemeLogger.warn('同步原生窗口主题失败', { error: String(error), theme: themePreference });
        });
    } catch (error) {
      appliedThemeLogger.warn('获取原生窗口实例失败，跳过窗口主题同步', { error: String(error), theme: themePreference });
    }
  }, [themePreference]);

  return { appliedTheme, systemThemeMode };
}
