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

function PreferenceNumber({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (nextValue: number) => void;
}) {
  return (
    <label className="settings-field" htmlFor={id}>
      <span className="settings-field__label">{label}</span>
      <div className="flex items-center gap-2">
        <input
          className="settings-select w-20 text-center"
          id={id}
          max={max}
          min={min}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isNaN(next)) {
              onChange(Math.max(min, Math.min(max, next)));
            }
          }}
          step={step ?? 1}
          type="number"
          value={value}
        />
        <input
          max={max}
          min={min}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isNaN(next)) {
              onChange(Math.max(min, Math.min(max, next)));
            }
          }}
          step={step ?? 1}
          style={{ flex: 1 }}
          type="range"
          value={value}
        />
      </div>
      <span className="settings-field__hint">{hint}</span>
    </label>
  );
}

function PreferenceCheckbox({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (nextValue: boolean) => void;
}) {
  return (
    <label className="themed-checkbox-row flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-[12px]" htmlFor={id}>
      <input
        checked={checked}
        className="themed-checkbox h-3.5 w-3.5 shrink-0"
        id={id}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium text-[var(--app-text)]">{label}</span>
        <span className="text-[var(--app-text-soft)]">{hint}</span>
      </span>
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
    <div className="app-overlay" role="presentation">
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

            <PreferenceCheckbox
              checked={preferences.showFileManager}
              hint={t('settings.showFileManagerHint')}
              id="settings-show-file-manager"
              label={t('settings.showFileManager')}
              onChange={(showFileManager) => onChange({ ...preferences, showFileManager })}
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

          <section className="settings-card">
            <div className="settings-card__title">
              <span className="settings-card__icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              </span>
              <div>
                <h4>{t('settings.terminal')}</h4>
                <p>{t('settings.terminalHint')}</p>
              </div>
            </div>

            <PreferenceNumber
              hint={t('settings.terminalFontSizeHint')}
              id="settings-terminal-font-size"
              label={t('settings.terminalFontSize')}
              max={20}
              min={10}
              onChange={(terminalFontSize) => onChange({ ...preferences, terminalFontSize })}
              value={preferences.terminalFontSize}
            />

            <PreferenceNumber
              hint={t('settings.terminalLineHeightHint')}
              id="settings-terminal-line-height"
              label={t('settings.terminalLineHeight')}
              max={20}
              min={10}
              step={1}
              onChange={(v) => onChange({ ...preferences, terminalLineHeight: v / 10 })}
              value={Math.round(preferences.terminalLineHeight * 10)}
            />
          </section>

          <section className="settings-card">
            <div className="settings-card__title">
              <span className="settings-card__icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
              </span>
              <div>
                <h4>{t('settings.behavior')}</h4>
                <p>{t('settings.behaviorHint')}</p>
              </div>
            </div>

            <PreferenceCheckbox
              checked={preferences.autoReconnect}
              hint={t('settings.autoReconnectHint')}
              id="settings-auto-reconnect"
              label={t('settings.autoReconnect')}
              onChange={(autoReconnect) => onChange({ ...preferences, autoReconnect })}
            />

            <PreferenceCheckbox
              checked={preferences.startupUpdateCheck}
              hint={t('settings.startupUpdateCheckHint')}
              id="settings-startup-update-check"
              label={t('settings.startupUpdateCheck')}
              onChange={(startupUpdateCheck) => onChange({ ...preferences, startupUpdateCheck })}
            />

            <PreferenceNumber
              hint={t('settings.historyLimitHint')}
              id="settings-history-limit"
              label={t('settings.historyLimit')}
              max={20}
              min={3}
              onChange={(historyLimit) => onChange({ ...preferences, historyLimit })}
              value={preferences.historyLimit}
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
