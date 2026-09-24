import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

// Kept in sync with isTauriRuntime() in '@/lib/ipc/tauri'. Duplicated on purpose:
// this module must stay dependency-light so it can be used outside the typed IPC
// adapter (e.g. from terminal panes) without pulling in the full command layer.
function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// WKWebView restricts navigator.clipboard to user-activation windows, which
// breaks copy-on-select and other deferred writes inside Tauri. Route through
// the native clipboard plugin instead and only fall back to the web API when
// running outside the Tauri shell (browser dev server, unit tests).
export async function writeClipboardText(text: string): Promise<void> {
  if (isTauriRuntime()) return writeText(text);
  return navigator.clipboard.writeText(text);
}

export async function readClipboardText(): Promise<string> {
  if (isTauriRuntime()) return readText();
  return navigator.clipboard.readText();
}
