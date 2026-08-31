import type { ThemeMode } from '@/types';

export type ResolvedTheme = Exclude<ThemeMode, 'system'>;
export const THEME_CACHE_KEY = 'shellspan.theme';

export function cacheTheme(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, mode);
  } catch {
    // The cache is only an optimization for the first paint.
  }
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return mode;
}

export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolvedTheme = resolveTheme(mode);
  cacheTheme(mode);
  document.documentElement.setAttribute('data-theme', resolvedTheme);
  document.documentElement.style.backgroundColor = 'var(--app-bg)';
  document.documentElement.style.colorScheme = resolvedTheme;
  return resolvedTheme;
}
