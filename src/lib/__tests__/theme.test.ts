import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, resolveTheme, THEME_CACHE_KEY } from '../theme';

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.removeProperty('background-color');
  document.documentElement.style.removeProperty('color-scheme');
  window.localStorage.removeItem(THEME_CACHE_KEY);
});

describe('theme', () => {
  it('applies an explicit theme before React renders', () => {
    expect(applyTheme('dark')).toBe('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement.style.backgroundColor).toBe('var(--app-bg)');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(window.localStorage.getItem(THEME_CACHE_KEY)).toBe('dark');
  });

  it('resolves the system theme from the current media query', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));

    expect(resolveTheme('system')).toBe('dark');
  });
});
