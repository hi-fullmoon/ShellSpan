import { CloseIcon, GlobeIcon, MoonIcon, SunIcon } from './Icons';
import { t } from '../lib/i18n';
import type { AppPreferences, LocalePreference, ThemePreference } from '../types';

interface SettingsDialogProps {
  open: boolean;
  preferences: AppPreferences;
  onChange: (nextPreferences: AppPreferences) => void;
  onClose: () => void;
}

function PreferenceSelect<T extends string>({
  id,
  label,
  hint,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  hint: string;
  value: T;
  onChange: (nextValue: T) => void;
  options: Array<{ value: T; label: string }>;
}) {
  return (
    <label className="settings-field" htmlFor={id}>
      <span className="settings-field__label">{label}</span>
      <select aria-label={label} className="settings-select" id={id} onChange={(event) => onChange(event.target.value as T)} value={value}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="settings-field__hint">{hint}</span>
    </label>
  );
}

function ThemePreview({ theme }: { theme: ThemePreference }) {
  return (
    <div className="settings-preview" data-theme-preview={theme}>
      <div className="settings-preview__windowbar">
        <span className="settings-preview__dot settings-preview__dot--close" />
        <span className="settings-preview__dot settings-preview__dot--min" />
        <span className="settings-preview__dot settings-preview__dot--max" />
      </div>
      <div className="settings-preview__app">
        <aside className="settings-preview__sidebar">
          <div className="settings-preview__title" />
          <div className="settings-preview__item settings-preview__item--active" />
          <div className="settings-preview__item" />
          <div className="settings-preview__item" />
        </aside>
        <section className="settings-preview__workspace">
          <div className="settings-preview__tabs">
            <div className="settings-preview__tab settings-preview__tab--active" />
            <div className="settings-preview__tab" />
            <div className="settings-preview__tab" />
          </div>
          <div className="settings-preview__terminals"></div>
        </section>
        <aside className="settings-preview__rightbar">
          <div className="settings-preview__title" />
          <div className="settings-preview__item settings-preview__item--active" />
          <div className="settings-preview__item" />
          <div className="settings-preview__item" />
          <div className="settings-preview__item" />
        </aside>
      </div>
    </div>
  );
}

export function SettingsDialog({ open, preferences, onChange, onClose }: SettingsDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="app-overlay" onClick={onClose} role="presentation">
      <div
        className="app-dialog settings-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
      >
        <div className="settings-dialog__header">
          <div>
            <p className="label">{t('settings.subtitle')}</p>
            <h3 className="dialog-title">{t('settings.title')}</h3>
            <p className="dialog-description">{t('settings.description')}</p>
          </div>
          <button aria-label={t('settings.close')} className="icon-btn" onClick={onClose} type="button">
            <CloseIcon />
          </button>
        </div>

        <div className="settings-grid">
          <section className="settings-card">
            <div className="settings-card__title">
              <span className="settings-card__icon">{preferences.theme === 'light' ? <SunIcon /> : <MoonIcon />}</span>
              <div>
                <h4>{t('settings.appearance')}</h4>
                <p>{t('settings.appearanceHint')}</p>
              </div>
            </div>

            <PreferenceSelect<ThemePreference>
              hint={t('settings.themeHint')}
              id="settings-theme"
              label={t('settings.theme')}
              onChange={(theme) => onChange({ ...preferences, theme })}
              options={[
                { value: 'system', label: t('settings.theme.system') },
                { value: 'dark', label: t('settings.theme.dark') },
                { value: 'light', label: t('settings.theme.light') },
              ]}
              value={preferences.theme}
            />
          </section>

          <section className="settings-card">
            <div className="settings-card__title">
              <span className="settings-card__icon">
                <GlobeIcon />
              </span>
              <div>
                <h4>{t('settings.language')}</h4>
                <p>{t('settings.languageHint')}</p>
              </div>
            </div>

            <PreferenceSelect<LocalePreference>
              hint={t('settings.languageHint')}
              id="settings-language"
              label={t('settings.language')}
              onChange={(locale) => onChange({ ...preferences, locale })}
              options={[
                { value: 'zh-CN', label: t('settings.language.zh-CN') },
                { value: 'en-US', label: t('settings.language.en-US') },
              ]}
              value={preferences.locale}
            />
          </section>
        </div>

        <section className="settings-card settings-card--preview">
          <div className="settings-card__title">
            <span className="settings-card__icon">{preferences.theme === 'light' ? <SunIcon /> : <MoonIcon />}</span>
            <div>
              <h4>{t('settings.preview')}</h4>
              <p>{t('settings.previewHint')}</p>
            </div>
          </div>
          <ThemePreview theme={preferences.theme} />
        </section>
      </div>
    </div>
  );
}
