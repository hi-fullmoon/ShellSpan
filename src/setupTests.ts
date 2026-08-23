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

class ResizeObserverMock implements ResizeObserver {
  disconnect(): void {}

  observe(target: Element): void {
    // Base UI's scroll viewport assumes Web Animations is available whenever
    // ResizeObserver is. Keep that polyfill scoped to the observed viewport so
    // popup/tab exit behavior still matches jsdom's animation-free behavior.
    if (target.getAttribute('data-slot') === 'scroll-area-viewport') {
      Object.defineProperty(target, 'getAnimations', {
        configurable: true,
        value: () => [],
      });
    }
  }

  unobserve(): void {}
}

Object.defineProperty(window, 'ResizeObserver', {
  configurable: true,
  writable: true,
  value: ResizeObserverMock,
});

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  writable: true,
  value: ResizeObserverMock,
});

// jsdom deliberately leaves canvas rendering unimplemented and prints an
// error whenever getContext() is called. Return null silently so components
// exercise their intended no-canvas/CSS fallback without changing layout.
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: vi.fn(() => null),
});

// jsdom does not yet expose the ARIA reflection properties used by
// react-resizable-panels to distinguish enabled separators.
if (!('ariaDisabled' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'ariaDisabled', {
    configurable: true,
    get() {
      return this.getAttribute('aria-disabled');
    },
    set(value: string | null) {
      if (value === null) this.removeAttribute('aria-disabled');
      else this.setAttribute('aria-disabled', value);
    },
  });
}
