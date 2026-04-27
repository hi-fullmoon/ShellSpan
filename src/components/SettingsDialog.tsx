import { useState, useRef, useEffect } from 'react';
import { CloseIcon, GlobeIcon, MoonIcon, SunIcon } from './Icons';
import { t } from '../lib/i18n';
import {
  DEFAULT_SHORTCUTS,
  formatKeyBinding,
  recordKeyBinding,
  SHORTCUT_ACTIONS,
  SHORTCUT_LABELS,
  type ShortcutAction,
} from '../lib/keyboard';
import type { AppPreferences, LocalePreference, ThemePreference } from '../types';

interface SettingsDialogProps {
  open: boolean;
  preferences: AppPreferences;
  onChange: (nextPreferences: AppPreferences) => void;
  onClose: () => void;
}

type SettingsTab = 'appearance' | 'language' | 'terminal' | 'behavior' | 'shortcuts';

const tabs: { key: SettingsTab; labelKey: string }[] = [
  { key: 'appearance', labelKey: 'settings.tabAppearance' },
  { key: 'language', labelKey: 'settings.tabLanguage' },
  { key: 'terminal', labelKey: 'settings.tabTerminal' },
  { key: 'behavior', labelKey: 'settings.tabBehavior' },
  { key: 'shortcuts', labelKey: 'settings.tabShortcuts' },
];

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

function ShortcutRow({
  action,
  binding,
  onChange,
  onReset,
}: {
  action: ShortcutAction;
  binding: string;
  onChange: (newBinding: string) => void;
  onReset: () => void;
}) {
  const [recording, setRecording] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!recording) return;

    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const newBinding = recordKeyBinding(event);
      if (newBinding) {
        onChange(newBinding);
        setRecording(false);
      }
    };

    // Use capture phase to intercept before other handlers
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [recording, onChange]);

  useEffect(() => {
    if (recording) {
      btnRef.current?.focus();
    }
  }, [recording]);

  return (
    <div className="shortcut-row">
      <span className="shortcut-row__label">{t(SHORTCUT_LABELS[action])}</span>
      <div className="flex items-center gap-1.5">
        <button
          ref={btnRef}
          className={`shortcut-key ${recording ? 'shortcut-key--recording' : ''}`}
          onClick={() => setRecording(true)}
          onBlur={() => setRecording(false)}
          type="button"
        >
          {recording ? t('shortcuts.recording') : formatKeyBinding(binding)}
        </button>
        {binding !== DEFAULT_SHORTCUTS[action] && (
          <button
            className="shortcut-reset"
            onClick={onReset}
            title={t('shortcuts.reset')}
            type="button"
          >
            {t('shortcuts.reset')}
          </button>
        )}
      </div>
    </div>
  );
}

export function SettingsDialog({ open, preferences, onChange, onClose }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');

  if (!open) {
    return null;
  }

  const shortcuts = { ...DEFAULT_SHORTCUTS, ...preferences.keyboardShortcuts };

  const setShortcut = (action: ShortcutAction, binding: string) => {
    onChange({
      ...preferences,
      keyboardShortcuts: { ...preferences.keyboardShortcuts, [action]: binding },
    });
  };

  const resetShortcut = (action: ShortcutAction) => {
    const next = { ...preferences.keyboardShortcuts };
    delete next[action];
    onChange({ ...preferences, keyboardShortcuts: next });
  };

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

        {/* Tab bar */}
        <div className="settings-tab-bar mt-2.5">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`settings-tab ${activeTab === tab.key ? 'settings-tab--active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
              type="button"
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        <div className="settings-content">
          {/* ───── Tab: Appearance ───── */}
        {activeTab === 'appearance' && (
          <div className="flex flex-col gap-3 mt-2.5">
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
          </div>
        )}

        {/* ───── Tab: Language ───── */}
        {activeTab === 'language' && (
          <div className="flex flex-col gap-3 mt-2.5">
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
        )}

        {/* ───── Tab: Terminal ───── */}
        {activeTab === 'terminal' && (
          <div className="flex flex-col gap-3 mt-2.5">
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
          </div>
        )}

        {/* ───── Tab: Behavior ───── */}
        {activeTab === 'behavior' && (
          <div className="flex flex-col gap-3 mt-2.5">
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
        )}

        {/* ───── Tab: Shortcuts ───── */}
        {activeTab === 'shortcuts' && (
          <div className="flex flex-col gap-2 mt-2.5">
            <p className="text-[11px] text-slate-500">{t('settings.shortcutsHint')}</p>
            {SHORTCUT_ACTIONS.map((action) => (
              <ShortcutRow
                action={action}
                binding={shortcuts[action]}
                key={action}
                onChange={(newBinding) => setShortcut(action, newBinding)}
                onReset={() => resetShortcut(action)}
              />
            ))}
          </div>
        )}

        </div>{/* end settings-content */}
      </div>
    </div>
  );
}
