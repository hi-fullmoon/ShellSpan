// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppliedTheme } from '../useAppliedTheme';

function createMatchMedia(matches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQueryList = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    dispatchChange: (nextMatches: boolean) => {
      mediaQueryList.matches = nextMatches;
      for (const listener of listeners) {
        listener({ matches: nextMatches } as MediaQueryListEvent);
      }
    },
  };
  return mediaQueryList;
}

describe('useAppliedTheme', () => {
  let currentMatchMedia: ReturnType<typeof createMatchMedia>;

  beforeEach(() => {
    currentMatchMedia = createMatchMedia(false);
    window.matchMedia = vi.fn().mockReturnValue(currentMatchMedia);
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies dark when theme preference is dark', () => {
    const { result } = renderHook(() => useAppliedTheme('dark'));

    expect(result.current.appliedTheme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('applies light when theme preference is light', () => {
    const { result } = renderHook(() => useAppliedTheme('light'));

    expect(result.current.appliedTheme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('follows system theme and updates when it changes', () => {
    currentMatchMedia = createMatchMedia(true);
    window.matchMedia = vi.fn().mockReturnValue(currentMatchMedia);

    const { result } = renderHook(() => useAppliedTheme('system'));

    expect(result.current.appliedTheme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    act(() => {
      currentMatchMedia.dispatchChange(false);
    });

    expect(result.current.appliedTheme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
