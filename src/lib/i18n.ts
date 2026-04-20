import intl from 'react-intl-universal';
import enUS from '../locales/en-US';
import zhCN from '../locales/zh-CN';
import type { LocalePreference } from '../types';

const locales = {
  'zh-CN': zhCN,
  'en-US': enUS,
} as const;

let activeLocale: LocalePreference = 'zh-CN';
let initialized = false;

function interpolate(message: string, variables?: Record<string, string | number>) {
  if (!variables) {
    return message;
  }

  return Object.entries(variables).reduce(
    (current, [key, value]) => current.split(`{${key}}`).join(String(value)),
    message,
  );
}

export function syncI18nLocale(locale: LocalePreference) {
  if (activeLocale !== locale) {
    initialized = false;
  }
  activeLocale = locale;
}

export async function initI18n(locale: LocalePreference) {
  activeLocale = locale;
  initialized = false;
  await intl.init({
    currentLocale: locale,
    locales,
  });
  initialized = true;
}

export function t(key: string, variables?: Record<string, string | number>, defaultMessage?: string) {
  const fallback =
    locales[activeLocale][key as keyof (typeof locales)[typeof activeLocale]] ??
    defaultMessage ??
    key;

  if (!initialized) {
    return interpolate(fallback, variables);
  }

  try {
    return intl.get(key, variables).d(fallback);
  } catch {
    return interpolate(fallback, variables);
  }
}
