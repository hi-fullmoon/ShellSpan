import intl from 'react-intl-universal';
import zhCN from './zh-CN';
import enUS from './en-US';
import type { Locale } from '@/types';

const locales: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

let initializedLocale: Locale | undefined;
let initializingLocale: Locale | undefined;
let initializationPromise: Promise<void> | undefined;

export type LocaleKey = keyof typeof zhCN;

function initializeLocale(locale: Locale): Promise<void> {
  if (initializingLocale === locale && initializationPromise) {
    return initializationPromise;
  }

  initializingLocale = locale;
  const pending = intl.init({
    currentLocale: locale,
    locales,
  });
  const tracked = pending.then(() => {
    if (initializationPromise === tracked) {
      initializedLocale = locale;
      initializingLocale = undefined;
      initializationPromise = undefined;
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
