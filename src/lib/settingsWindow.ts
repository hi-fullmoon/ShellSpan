import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { emit, emitTo, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createLogger } from './logger';
import { isTauriRuntime } from './tauri';
import type { AppPreferences } from '../types';

const settingsWindowLogger = createLogger('settings-window');

export const SETTINGS_INIT_EVENT = 'settings:init';
export const SETTINGS_CHANGED_EVENT = 'settings:changed';
export const SETTINGS_OPEN_EVENT = 'settings:open';

const SETTINGS_WINDOW_LABEL = 'settings';

export async function openSettingsWindow(preferences: AppPreferences): Promise<void> {
  if (!isTauriRuntime()) {
    settingsWindowLogger.warn('非 Tauri 运行时，无法打开设置窗口');
    return;
  }

  const existing = await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL);
  if (existing) {
    await existing.show();
    await existing.setFocus();
    await emitTo(SETTINGS_WINDOW_LABEL, SETTINGS_INIT_EVENT, preferences);
    return;
  }

  const webview = new WebviewWindow(SETTINGS_WINDOW_LABEL, {
    url: 'settings.html',
    title: 'Settings',
    width: 720,
    height: 540,
    minWidth: 600,
    minHeight: 420,
    resizable: true,
    fullscreen: false,
    transparent: true,
    decorations: false,
    alwaysOnTop: true,
    parent: 'main',
    visible: false,
    center: true,
  });

  const unlistenCreated = await webview.once('tauri://created', async () => {
    settingsWindowLogger.info('设置窗口创建成功');
    await webview.show();
    await webview.setFocus();
    await emitTo(SETTINGS_WINDOW_LABEL, SETTINGS_INIT_EVENT, preferences);
  });

  const unlistenError = await webview.once('tauri://error', (event) => {
    settingsWindowLogger.error('设置窗口创建失败', { error: String(event.payload) });
  });

  // 清理一次性监听器（创建成功或失败后都不再需要）
  setTimeout(() => {
    unlistenCreated();
    unlistenError();
  }, 5000);
}

export function listenSettingsChanged(
  onChange: (nextPreferences: AppPreferences) => void,
): () => void {
  if (!isTauriRuntime()) {
    return () => {};
  }

  let stopListen: UnlistenFn | undefined;
  let cancelled = false;

  void (async () => {
    stopListen = await listen<AppPreferences>(SETTINGS_CHANGED_EVENT, (event) => {
      if (!cancelled) {
        onChange(event.payload);
      }
    });
  })();

  return () => {
    cancelled = true;
    stopListen?.();
  };
}

export async function emitSettingsChanged(nextPreferences: AppPreferences): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }

  await emit(SETTINGS_CHANGED_EVENT, nextPreferences);
}

export function listenSettingsInit(handler: (preferences: AppPreferences) => void): () => void {
  if (!isTauriRuntime()) {
    return () => {};
  }

  let stopListen: UnlistenFn | undefined;
  let cancelled = false;

  void (async () => {
    stopListen = await listen<AppPreferences>(SETTINGS_INIT_EVENT, (event) => {
      if (!cancelled) {
        handler(event.payload);
      }
    });
  })();

  return () => {
    cancelled = true;
    stopListen?.();
  };
}

export async function closeSettingsWindow(): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }

  try {
    await getCurrentWindow().close();
  } catch (error) {
    settingsWindowLogger.error('关闭设置窗口失败', { error: String(error) });
  }
}
