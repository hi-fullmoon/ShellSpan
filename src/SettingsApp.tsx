import React from 'react';
import { useTheme } from '@/hooks/useTheme';
import { useI18n } from '@/hooks/useI18n';
import { useDisableContextMenu } from '@/hooks/useDisableContextMenu';
import { useAppStore } from '@/stores/appStore';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import type { Locale, ThemeMode } from '@/types';

export const SettingsApp: React.FC = () => {
  useDisableContextMenu();
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
              <Label className="text-xs text-app-text-soft">
                {t('settings.appearance.theme')}
              </Label>
              <Select value={theme} onValueChange={(value) => setTheme(value as ThemeMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">{t('theme.light')}</SelectItem>
                  <SelectItem value="dark">{t('theme.dark')}</SelectItem>
                  <SelectItem value="system">{t('theme.system')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-xs text-app-text-soft">
                {t('settings.appearance.language')}
              </Label>
              <Select value={locale} onValueChange={(value) => setLocale(value as Locale)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="zh-CN">{t('locale.zh-CN')}</SelectItem>
                  <SelectItem value="en-US">{t('locale.en-US')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
