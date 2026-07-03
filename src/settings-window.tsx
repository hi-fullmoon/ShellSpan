import React, { useEffect, useState, useCallback } from 'react';
import ReactDOM from 'react-dom/client';

import { ChakraProvider, ErrorBoundary } from './components/ui';
import { SettingsPanel } from './components/SettingsPanel';
import { CloseIcon } from './components/ui';
import { initI18n, syncI18nLocale, t } from './lib/i18n';
import { createLogger } from './lib/logger';
import { isTauriRuntime } from './lib/tauri';
import { defaultPreferences, normalizePreferences } from './lib/appHelpers';
import { useAppliedTheme } from './hooks/useAppliedTheme';
import {
  closeSettingsWindow,
  emitSettingsChanged,
  listenSettingsInit,
} from './lib/settingsWindow';
import type { AppPreferences } from './types';

import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';
import '@xterm/xterm/css/xterm.css';
import './styles/index.css';

const settingsLogger = createLogger('settings-window');

function SettingsWindow() {
  const [preferences, setPreferences] = useState<AppPreferences>(() => {
    if (typeof window !== 'undefined') {
      const raw = window.localStorage.getItem('termbridge.preferences');
      if (raw) {
        try {
          return normalizePreferences(JSON.parse(raw));
        } catch (error) {
          settingsLogger.warn('从 localStorage 读取偏好设置失败', { error: String(error) });
        }
      }
    }
    return normalizePreferences(defaultPreferences);
  });

  useAppliedTheme(preferences.theme);

  useEffect(() => {
    void initI18n(preferences.locale).catch((error) => {
      settingsLogger.error('初始化国际化失败', { error: String(error) });
    });
  }, [preferences.locale]);

  useEffect(() => {
    syncI18nLocale(preferences.locale);
  }, [preferences.locale]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const stopListen = listenSettingsInit((initialPreferences) => {
      setPreferences(normalizePreferences(initialPreferences));
    });

    return () => {
      stopListen();
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void closeSettingsWindow();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleChange = useCallback((nextPreferences: AppPreferences) => {
    setPreferences(nextPreferences);
    void emitSettingsChanged(nextPreferences);
  }, []);

  return (
    <main className="h-screen overflow-hidden flex flex-col bg-[var(--app-bg)] shadow-2xl">
      <div
        className="flex h-11 shrink-0 items-center justify-between bg-[var(--app-surface-muted)] px-3"
        data-tauri-drag-region
      >
        <span className="text-sm font-semibold text-[var(--app-text)]" data-tauri-drag-region>
          {t('settings.title')}
        </span>
        <button
          aria-label={t('app.common.close')}
          className="icon-btn h-7 w-7"
          onClick={() => void closeSettingsWindow()}
          title={t('app.common.close')}
          type="button"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <SettingsPanel
          onChange={handleChange}
          preferences={preferences}
          showTabs
        />
      </div>
    </main>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
function bootstrap() {
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    settingsLogger.error('找不到 #root 元素，设置窗口无法挂载');
    return;
  }

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ChakraProvider>
        <ErrorBoundary>
          <SettingsWindow />
        </ErrorBoundary>
      </ChakraProvider>
    </React.StrictMode>,
  );
}

bootstrap();
