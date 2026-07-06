import { getCurrentWebviewWindow, WebviewWindow } from '@tauri-apps/api/webviewWindow';

export async function openSettingsWindow(): Promise<void> {
  const existing = await WebviewWindow.getByLabel('settings');
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }

  const current = getCurrentWebviewWindow();
  const settings = new WebviewWindow('settings', {
    url: 'settings.html',
    width: 720,
    height: 540,
    minWidth: 600,
    minHeight: 420,
    resizable: true,
    transparent: true,
    decorations: true,
    alwaysOnTop: true,
    parent: current,
  });

  settings.once('tauri://error', () => {
    // Ignore creation errors.
  });
}
