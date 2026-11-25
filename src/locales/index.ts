import intl from 'react-intl-universal';
import type zhCN from './zh-CN';
import type { Locale } from '@/types';

const loadedLocales: Partial<Record<Locale, Record<string, string>>> = {};
const localeLoaders: Record<Locale, () => Promise<{ default: Record<string, string> }>> = {
  'zh-CN': () => import('./zh-CN'),
  'en-US': () => import('./en-US'),
};

let initializedLocale: Locale | undefined;
let initializingLocale: Locale | undefined;
let initializationPromise: Promise<void> | undefined;
let localeRequestId = 0;
const localeListeners = new Set<() => void>();

export type LocaleKey = keyof typeof zhCN;

export function getInitializedLocale(): Locale | undefined {
  return initializedLocale;
}

export function subscribeLocale(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
}

function notifyLocaleListeners(): void {
  for (const listener of localeListeners) {
    listener();
  }
}

function applyLocale(locale: Locale): Promise<void> {
  return intl.init({
    currentLocale: locale,
    locales: loadedLocales as Record<Locale, Record<string, string>>,
  });
}

function initializeLocale(locale: Locale): Promise<void> {
  if (initializingLocale === locale && initializationPromise) {
    return initializationPromise;
  }

  initializingLocale = locale;
  const requestId = ++localeRequestId;
  const pending = loadedLocales[locale]
    ? applyLocale(locale)
    : localeLoaders[locale]().then((mod) => {
        loadedLocales[locale] = mod.default;
        if (requestId !== localeRequestId) return;
        return applyLocale(locale);
      });
  const tracked = pending.then(() => {
    if (initializationPromise === tracked && requestId === localeRequestId) {
      initializedLocale = locale;
      initializingLocale = undefined;
      initializationPromise = undefined;
      notifyLocaleListeners();
    }
  }, (error: unknown) => {
    if (initializationPromise === tracked) {
      initializingLocale = undefined;
      initializationPromise = undefined;
    }
    throw error;
  });
  initializationPromise = tracked;
  return initializationPromise;
}

export function initI18n(locale: Locale): Promise<void> {
  return initializeLocale(locale);
}

export function changeLocale(locale: Locale): Promise<void> {
  if (initializedLocale === locale && initializingLocale === undefined) {
    return Promise.resolve();
  }
  return initializeLocale(locale);
}

export function t(key: LocaleKey, variables?: Record<string, string | number>): string {
  return variables ? intl.get(key, variables).d(String(key)) : intl.get(key).d(String(key));
}

export { intl };
