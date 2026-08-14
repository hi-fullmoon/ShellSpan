import '@testing-library/jest-dom';
import { beforeEach, vi } from 'vitest';
import { clearDirectoryListingCache } from '@/lib/directory-listing-cache';

// The directory listing cache is module-level state; reset it between tests
// so cached entries never leak across test cases.
beforeEach(() => {
  clearDirectoryListingCache();
});

// Node >= 22 ships an experimental `localStorage` global that shadows jsdom's
// Storage during environment population and returns `undefined` unless the
// process was started with `--localstorage-file`. Provide a real in-memory
// Storage so tests that read/write window.localStorage behave correctly.
const store = new Map<string, string>();
const localStorageMock: Storage = {
  get length() {
    return store.size;
  },
  clear() {
    store.clear();
  },
  getItem(key) {
    return store.get(key) ?? null;
  },
  key(index) {
    return Array.from(store.keys())[index] ?? null;
  },
  removeItem(key) {
    store.delete(key);
  },
  setItem(key, value) {
    store.set(key, String(value));
  },
};

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: localStorageMock,
});

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: localStorageMock,
});

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});
