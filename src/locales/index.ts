import intl from 'react-intl-universal';
import zhCN from './zh-CN';
import enUS from './en-US';
import type { Locale } from '@/types';

const locales: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

let initializedLocale: Locale | undefined;

export type LocaleKey = keyof typeof zhCN;

export function initI18n(locale: Locale): Promise<void> {
  initializedLocale = locale;
  return intl.init({
    currentLocale: locale,
    locales,
  });
}

export function changeLocale(locale: Locale): Promise<void> {
  if (initializedLocale === locale) return Promise.resolve();
  initializedLocale = locale;
  return intl.init({
    currentLocale: locale,
    locales,
  });
}

export function t(key: LocaleKey, variables?: Record<string, string | number>): string {
  return variables ? intl.get(key, variables).d(String(key)) : intl.get(key).d(String(key));
}

export { intl };
