import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { changeLocale, getInitializedLocale, subscribeLocale, t, type LocaleKey } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { Locale } from '@/types';

export function useI18n(): {
  ready: boolean;
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: LocaleKey, variables?: Record<string, string | number>) => string;
} {
  const locale = useAppStore((state) => state.locale);
  const setLocaleStore = useAppStore((state) => state.setLocale);
  const activeLocale = useSyncExternalStore(
    subscribeLocale,
    getInitializedLocale,
    getInitializedLocale,
  );
  const ready = activeLocale === locale;

  useEffect(() => {
    if (activeLocale === locale) return;
    void changeLocale(locale);
  }, [activeLocale, locale]);

  const setLocale = (next: Locale): void => {
    setLocaleStore(next);
  };

  const translate = useCallback(
    (key: LocaleKey, variables?: Record<string, string | number>): string =>
      t(key, variables),
    [activeLocale, locale],
  );

  return { ready, locale, setLocale, t: translate };
}
