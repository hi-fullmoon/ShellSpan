import { useState, useRef, useEffect } from 'react';
import { GlobeIcon, MoonIcon, SunIcon } from './Icons';
import { t } from '../lib/i18n';
import { DEFAULT_SHORTCUTS, formatKeyBinding, recordKeyBinding, SHORTCUT_ACTIONS, SHORTCUT_LABELS, type ShortcutAction } from '../lib/keyboard';
import type { AppPreferences, LocalePreference, ThemePreference, TerminalTheme, CursorStyle, Snippet } from '../types';

export interface SettingsPanelProps {
  preferences: AppPreferences;
  onChange: (nextPreferences: AppPreferences) => void;
  snippets?: Snippet[];
  onAddSnippet?: (name: string, command: string) => void;
  onUpdateSnippet?: (id: string, name: string, command: string) => void;
  onDeleteSnippet?: (id: string) => void;
  onMoveSnippet?: (id: string, direction: 'up' | 'down') => void;
  showTabs?: boolean;
}

type SettingsTab = 'appearance' | 'language' | 'terminal' | 'behavior' | 'shortcuts' | 'snippets';

const tabs: { key: SettingsTab; labelKey: string }[] = [
  { key: 'appearance', labelKey: 'settings.tabAppearance' },
  { key: 'language', labelKey: 'settings.tabLanguage' },
  { key: 'terminal', labelKey: 'settings.tabTerminal' },
  { key: 'behavior', labelKey: 'settings.tabBehavior' },
  { key: 'shortcuts', labelKey: 'settings.tabShortcuts' },
  { key: 'snippets', labelKey: 'settings.tabSnippets' },
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
      <span className="settings-field-label">{label}</span>
      <select aria-label={label} className="settings-select" id={id} onChange={(event) => onChange(event.target.value as T)} value={value}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <span className="settings-field-hint">{hint}</span>
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
      <span className="settings-field-label">{label}</span>
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
      <span className="settings-field-hint">{hint}</span>
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
    <label className="themed-checkbox-row flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[12px]" htmlFor={id}>
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
      <span className="shortcut-row-label">{t(SHORTCUT_LABELS[action])}</span>
      <div className="flex items-center gap-1.5">
        <button
          ref={btnRef}
          className={`shortcut-key ${recording ? 'shortcut-key-recording' : ''}`}
          onClick={() => setRecording(true)}
          onBlur={() => setRecording(false)}
          type="button"
        >
          {recording ? t('shortcuts.recording') : formatKeyBinding(binding)}
        </button>
        {binding !== DEFAULT_SHORTCUTS[action] && (
          <button className="shortcut-reset" onClick={onReset} title={t('shortcuts.reset')} type="button">
            {t('shortcuts.reset')}
          </button>
        )}
      </div>
    </div>
  );
}

function SnippetRow({
  snippet,
  isEditing,
  onEdit,
  onSave,
  onCancel,
  onDelete,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: {
  snippet: Snippet;
  isEditing: boolean;
  onEdit: () => void;
  onSave: (name: string, command: string) => void;
  onCancel: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const [editName, setEditName] = useState(snippet.name);
  const [editCommand, setEditCommand] = useState(snippet.command);

  if (isEditing) {
    return (
      <div className="settings-card gap-2">
        <input
          className="themed-input h-8 rounded-md px-2 text-xs"
          placeholder={t('settings.snippets.namePlaceholder')}
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
        />
        <input
          className="themed-input h-8 rounded-md px-2 text-xs"
          placeholder={t('settings.snippets.commandPlaceholder')}
          type="text"
          value={editCommand}
          onChange={(e) => setEditCommand(e.target.value)}
        />
        <div className="flex gap-1.5">
          <button className="icon-btn h-7 px-2 text-xs" onClick={() => onSave(editName, editCommand)} type="button">
            {t('settings.snippets.save')}
          </button>
          <button className="icon-btn h-7 px-2 text-xs" onClick={onCancel} type="button">
            {t('settings.snippets.cancel')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="shortcut-row">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="shortcut-row-label truncate">{snippet.name}</span>
        <span className="truncate text-[11px] text-[var(--app-text-soft)] font-mono">{snippet.command}</span>
      </div>
      <div className="flex items-center gap-1">
        <button
          className="icon-btn h-6 w-6 px-0 text-xs disabled:opacity-30"
          disabled={!canMoveUp}
          onClick={onMoveUp}
          title={t('settings.snippets.moveUp')}
          type="button"
        >
          ↑
        </button>
        <button
          className="icon-btn h-6 w-6 px-0 text-xs disabled:opacity-30"
          disabled={!canMoveDown}
          onClick={onMoveDown}
          title={t('settings.snippets.moveDown')}
          type="button"
        >
          ↓
        </button>
        <button className="icon-btn h-6 w-6 px-0 text-xs" onClick={onEdit} title={t('settings.snippets.edit')} type="button">
          ✎
        </button>
        <button className="icon-btn h-6 w-6 px-0 text-xs text-rose-400" onClick={onDelete} title={t('settings.snippets.delete')} type="button">
          ✕
        </button>
      </div>
    </div>
  );
}

export function SettingsPanel({
  preferences,
  onChange,
  snippets = [],
  onAddSnippet,
  onUpdateSnippet,
  onDeleteSnippet,
  onMoveSnippet,
  showTabs = true,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');
  const [newSnippetName, setNewSnippetName] = useState('');
  const [newSnippetCommand, setNewSnippetCommand] = useState('');
  const [editingSnippetId, setEditingSnippetId] = useState<string | null>(null);

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
    <>
      {showTabs && (
        /* Tab bar */
        <div className="settings-tab-bar px-2">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`settings-tab ${activeTab === tab.key ? 'settings-tab-active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
              type="button"
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
      )}

      <div className="settings-content h-0 flex-1 overflow-auto px-2 pb-2">
        {/* ───── Tab: Appearance ───── */}
        {(showTabs ? activeTab === 'appearance' : true) && (
          <div className="flex flex-col gap-3 mt-2.5">
            <section className="settings-card">
              <div className="settings-card-title">
                <span className="settings-card-icon">{preferences.theme === 'light' ? <SunIcon /> : <MoonIcon />}</span>
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
              <div className="settings-card-title">
                <span className="settings-card-icon">
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
              <div className="settings-card-title">
                <span className="settings-card-icon">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
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

              <PreferenceSelect<TerminalTheme>
                hint={t('settings.terminalThemeHint')}
                id="settings-terminal-theme"
                label={t('settings.terminalTheme')}
                onChange={(terminalTheme) => onChange({ ...preferences, terminalTheme })}
                options={[
                  { value: 'default', label: t('settings.terminalTheme.default') },
                  { value: 'dracula', label: t('settings.terminalTheme.dracula') },
                  { value: 'solarized-dark', label: t('settings.terminalTheme.solarizedDark') },
                  { value: 'solarized-light', label: t('settings.terminalTheme.solarizedLight') },
                  { value: 'one-dark', label: t('settings.terminalTheme.oneDark') },
                  { value: 'monokai', label: t('settings.terminalTheme.monokai') },
                ]}
                value={preferences.terminalTheme}
              />

              <PreferenceSelect<CursorStyle>
                hint={t('settings.cursorStyleHint')}
                id="settings-cursor-style"
                label={t('settings.cursorStyle')}
                onChange={(cursorStyle) => onChange({ ...preferences, cursorStyle })}
                options={[
                  { value: 'block', label: t('settings.cursorStyle.block') },
                  { value: 'line', label: t('settings.cursorStyle.line') },
                  { value: 'bar', label: t('settings.cursorStyle.bar') },
                ]}
                value={preferences.cursorStyle}
              />

              <PreferenceCheckbox
                checked={preferences.cursorBlink}
                hint={t('settings.cursorBlinkHint')}
                id="settings-cursor-blink"
                label={t('settings.cursorBlink')}
                onChange={(cursorBlink) => onChange({ ...preferences, cursorBlink })}
              />

              <PreferenceCheckbox
                checked={preferences.copyOnSelect}
                hint={t('settings.copyOnSelectHint')}
                id="settings-copy-on-select"
                label={t('settings.copyOnSelect')}
                onChange={(copyOnSelect) => onChange({ ...preferences, copyOnSelect })}
              />
            </section>
          </div>
        )}

        {/* ───── Tab: Behavior ───── */}
        {activeTab === 'behavior' && (
          <div className="flex flex-col gap-3 mt-2.5">
            <section className="settings-card">
              <div className="settings-card-title">
                <span className="settings-card-icon">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
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

        {/* ───── Tab: Snippets ───── */}
        {activeTab === 'snippets' && (
          <div className="flex flex-col gap-3 mt-2.5">
            <p className="text-[11px] text-slate-500">{t('settings.snippetsHint')}</p>

            {snippets.map((snippet, index) => (
              <SnippetRow
                canMoveDown={index < snippets.length - 1}
                canMoveUp={index > 0}
                isEditing={editingSnippetId === snippet.id}
                key={snippet.id}
                onCancel={() => setEditingSnippetId(null)}
                onDelete={() => onDeleteSnippet?.(snippet.id)}
                onEdit={() => setEditingSnippetId(snippet.id)}
                onMoveDown={() => onMoveSnippet?.(snippet.id, 'down')}
                onMoveUp={() => onMoveSnippet?.(snippet.id, 'up')}
                onSave={(name, command) => onUpdateSnippet?.(snippet.id, name, command)}
                snippet={snippet}
              />
            ))}

            <div className="settings-card gap-2">
              <p className="settings-card-title text-xs font-medium">{t('settings.snippets.addNew')}</p>
              <input
                className="themed-input h-8 rounded-md px-2 text-xs"
                placeholder={t('settings.snippets.namePlaceholder')}
                type="text"
                value={newSnippetName}
                onChange={(e) => setNewSnippetName(e.target.value)}
              />
              <input
                className="themed-input h-8 rounded-md px-2 text-xs"
                placeholder={t('settings.snippets.commandPlaceholder')}
                type="text"
                value={newSnippetCommand}
                onChange={(e) => setNewSnippetCommand(e.target.value)}
              />
              <button
                className="icon-btn h-7 px-2 text-xs self-start"
                onClick={() => {
                  if (newSnippetName.trim() && newSnippetCommand.trim()) {
                    onAddSnippet?.(newSnippetName.trim(), newSnippetCommand.trim());
                    setNewSnippetName('');
                    setNewSnippetCommand('');
                  }
                }}
                type="button"
              >
                {t('settings.snippets.add')}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
