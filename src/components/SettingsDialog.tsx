import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../lib/i18n';
import { cn } from '../lib/ui';
import { SettingsPanel, SETTINGS_TABS, type SettingsTab } from './SettingsPanel';
import { CloseIcon, SunIcon, MoonIcon, GlobeIcon } from './ui';
import type { AppPreferences } from '../types';

interface SettingsDialogProps {
  open: boolean;
  preferences: AppPreferences;
  onClose: () => void;
  onChange: (nextPreferences: AppPreferences) => void;
}

function TabIcon({ tab, theme }: { tab: SettingsTab; theme: AppPreferences['theme'] }) {
  switch (tab) {
    case 'appearance':
      return theme === 'light' ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />;
    case 'language':
      return <GlobeIcon className="h-4 w-4" />;
    case 'terminal':
      return (
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      );
    case 'behavior':
      return (
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case 'shortcuts':
      return (
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M6 8h.01" />
          <path d="M10 8h.01" />
          <path d="M14 8h.01" />
          <path d="M18 8h.01" />
          <path d="M8 12h.01" />
          <path d="M12 12h.01" />
          <path d="M16 12h.01" />
          <path d="M7 16h10" />
        </svg>
      );
    default:
      return null;
  }
}

export function SettingsDialog({ open, preferences, onClose, onChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');

  useEffect(() => {
    if (open) {
      setActiveTab('appearance');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="app-overlay" role="presentation" onClick={onClose}>
      <div
        className="flex h-[80vh] w-full max-w-2xl overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
      >
        {/* Sidebar */}
        <aside className="flex w-44 min-w-0 flex-col border-r border-[var(--app-border)] bg-[var(--app-surface-muted)]">
          <div className="flex h-11 items-center border-b border-[var(--app-border)] px-3">
            <h2 className="text-sm font-semibold text-[var(--app-text)]">{t('settings.title')}</h2>
          </div>
          <nav className="flex-1 overflow-y-auto p-2">
            <div className="flex flex-col gap-0.5">
              {SETTINGS_TABS.map((tab) => (
                <button
                  key={tab.key}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] font-medium transition',
                    activeTab === tab.key
                      ? 'bg-[var(--app-surface-active)] text-[var(--app-text)]'
                      : 'text-[var(--app-text-soft)] hover:bg-[var(--app-surface-hover)] hover:text-[var(--app-text)]',
                  )}
                  onClick={() => setActiveTab(tab.key)}
                  type="button"
                >
                  <TabIcon tab={tab.key} theme={preferences.theme} />
                  <span className="truncate">{t(tab.labelKey)}</span>
                </button>
              ))}
            </div>
          </nav>
        </aside>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col bg-[var(--app-bg)]">
          <div className="flex h-11 items-center justify-between border-b border-[var(--app-border)] px-3">
            <span className="text-sm font-medium text-[var(--app-text-soft)]">
              {t(SETTINGS_TABS.find((t) => t.key === activeTab)?.labelKey ?? 'settings.tabAppearance')}
            </span>
            <button
              className="icon-btn h-7 w-7"
              onClick={onClose}
              title={t('app.common.close')}
              type="button"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            <SettingsPanel
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onChange={onChange}
              preferences={preferences}
              showTabs={false}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
