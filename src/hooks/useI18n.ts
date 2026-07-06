import { useEffect, useState } from 'react';
import { changeLocale, t, type LocaleKey } from '@/locales';
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
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    changeLocale(locale).then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const setLocale = (next: Locale): void => {
    setReady(false);
    setLocaleStore(next);
  };

  return { ready, locale, setLocale, t };
}
