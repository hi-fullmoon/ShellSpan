import { useCallback, useEffect, useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import { applyTheme, resolveTheme } from '@/lib/theme';
import type { ThemeMode } from '@/types';

export function useTheme(): {
  theme: ThemeMode;
  resolvedTheme: 'light' | 'dark';
  setTheme: (theme: ThemeMode) => void;
} {
  const theme = useAppStore((state) => state.theme);
  const setThemeStore = useAppStore((state) => state.setTheme);
  const resolvedTheme = useMemo(() => resolveTheme(theme), [theme]);
  const setTheme = useCallback((nextTheme: ThemeMode): void => {
    // Apply synchronously so the next browser paint already uses the new theme.
    applyTheme(nextTheme);
    setThemeStore(nextTheme);
  }, [setThemeStore]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (): void => {
      applyTheme('system');
    };
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [theme]);

  return { theme, resolvedTheme, setTheme };
}
