import { getCurrentThemeMode } from './ui';

type ThemeListener = (mode: 'dark' | 'light') => void;

const listeners = new Set<ThemeListener>();
let observer: MutationObserver | null = null;
let currentMode: 'dark' | 'light' = getCurrentThemeMode();

function ensureObserver() {
  if (observer || typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return;
  }

  observer = new MutationObserver(() => {
    const next = getCurrentThemeMode();
    if (next === currentMode) {
      return;
    }
    currentMode = next;
    for (const listener of listeners) {
      listener(next);
    }
  });

  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

export function subscribeThemeMode(listener: ThemeListener): () => void {
  listeners.add(listener);
  ensureObserver();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && observer) {
      observer.disconnect();
      observer = null;
    }
  };
}

export function getCurrentThemeModeSync(): 'dark' | 'light' {
  return currentMode;
}
