import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useEffect } from 'react';
import { createLogger } from '../lib/logger';
import { isTauriRuntime } from '../lib/tauri';
import { SETTINGS_CHANGED_EVENT, SYSTEM_OPEN_SETTINGS_EVENT } from '../lib/appHelpers';
import type { AppPreferences } from '../types';

const systemEventsLogger = createLogger('app');

export interface TauriSystemEventHandlers {
  onOpenSettings: () => void;
  onRequestAppExit: () => void;
  onAbout: () => void;
  onSettingsChangedExternal: () => void;
}

export function useTauriSystemEvents(handlers: TauriSystemEventHandlers) {
  const { onOpenSettings, onRequestAppExit, onAbout, onSettingsChangedExternal } = handlers;

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let stopSystemOpenSettings: UnlistenFn | undefined;
    let stopSettingsChanged: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      try {
        const nextStopSystemOpenSettings = await listen(SYSTEM_OPEN_SETTINGS_EVENT, () => {
          onOpenSettings();
        });

        if (cancelled) {
          nextStopSystemOpenSettings();
          return;
        }

        stopSystemOpenSettings = nextStopSystemOpenSettings;

        const nextStopSettingsChanged = await listen(SETTINGS_CHANGED_EVENT, () => {
          onSettingsChangedExternal();
        });

        if (cancelled) {
          nextStopSettingsChanged();
          return;
        }

        stopSettingsChanged = nextStopSettingsChanged;
      } catch (error) {
        systemEventsLogger.error('监听系统设置事件失败', { error: String(error) });
      }
    };

    void attach();

    return () => {
      cancelled = true;
      stopSystemOpenSettings?.();
      stopSettingsChanged?.();
    };
  }, [onOpenSettings, onSettingsChangedExternal]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let stopAppExitRequest: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      try {
        const nextStopAppExitRequest = await listen('system-request-app-exit', () => {
          onRequestAppExit();
        });

        if (cancelled) {
          nextStopAppExitRequest();
          return;
        }

        stopAppExitRequest = nextStopAppExitRequest;
      } catch (error) {
        systemEventsLogger.error('监听系统退出请求事件失败', { error: String(error) });
      }
    };

    void attach();

    return () => {
      cancelled = true;
      stopAppExitRequest?.();
    };
  }, [onRequestAppExit]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let stopAboutRequest: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      try {
        const nextStopAboutRequest = await listen('system-about', () => {
          onAbout();
        });

        if (cancelled) {
          nextStopAboutRequest();
          return;
        }

        stopAboutRequest = nextStopAboutRequest;
      } catch (error) {
        systemEventsLogger.error('监听 about 事件失败', { error: String(error) });
      }
    };

    void attach();

    return () => {
      cancelled = true;
      stopAboutRequest?.();
    };
  }, [onAbout]);
}

export function readPreferencesFromLocalStorage(): Partial<AppPreferences> | null {
  try {
    const rawPrefs = window.localStorage.getItem('termbridge.preferences');
    if (rawPrefs) {
      return JSON.parse(rawPrefs) as Partial<AppPreferences>;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}
