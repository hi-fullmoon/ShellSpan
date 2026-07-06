import React from 'react';
import { useTheme } from '@/hooks/useTheme';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { Select } from '@/components/ui/Select';
import type { Locale, ThemeMode } from '@/types';

export const SettingsApp: React.FC = () => {
  const { t, locale, setLocale } = useI18n();
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex h-full flex-col overflow-hidden bg-app-surface">
      <div className="flex h-12 items-center border-b border-app-border bg-app-surface-muted px-4">
        <span className="text-base font-semibold text-app-text">
          {t('section.settings')}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-4">
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-app-text">
            {t('settings.appearance.title')}
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-app-text-soft">
                {t('settings.appearance.theme')}
              </label>
              <Select
                value={theme}
                options={[
                  { value: 'light', label: t('theme.light') },
                  { value: 'dark', label: t('theme.dark') },
                  { value: 'system', label: t('theme.system') },
                ]}
                onChange={(e) => setTheme(e.target.value as ThemeMode)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-app-text-soft">
                {t('settings.appearance.language')}
              </label>
              <Select
                value={locale}
                options={[
                  { value: 'zh-CN', label: t('locale.zh-CN') },
                  { value: 'en-US', label: t('locale.en-US') },
                ]}
                onChange={(e) => setLocale(e.target.value as Locale)}
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
