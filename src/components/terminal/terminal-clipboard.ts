import { readClipboardText, writeClipboardText } from '@/lib/clipboard';
import { isTauriRuntime } from '@/lib/ipc/tauri';
import { getPlatform } from '@/lib/platform';
import { t } from '@/locales';
import { useToastStore } from '@/stores/toastStore';
import type { Terminal } from '@xterm/xterm';

export function exactTerminalPasteText(eventText: string, clipboardText: string): string {
  // WKWebView composes decomposed clipboard text before exposing ClipboardEvent.
  // Recover the native bytes only for the same canonical text; a clipboard
  // change while the IPC read is pending must not paste unrelated content.
  return clipboardText.normalize('NFC') === eventText.normalize('NFC') ? clipboardText : eventText;
}

export function installTerminalPasteHandler(terminal: Pick<Terminal, 'element' | 'onData'>, paste: (text: string) => void, onError: () => void): () => void {
  const element = terminal.element;
  if (!element) return () => {};
  let disposed = false;
  let inputRevision = 0, applyingPaste = false;
  const inputSubscription = terminal.onData(() => { if (!applyingPaste) inputRevision++; });
  let pending = Promise.resolve();
  const handlePaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    event.stopPropagation();
    if (getPlatform() !== 'macos' || !isTauriRuntime()) {
      paste(text);
      return;
    }
    const revision = inputRevision;
    // Keep physical paste events ordered and drop pending reads after rebinding
    // or later keyboard input; a late clipboard result must not reach a new line.
    pending = pending.then(async () => {
      if (disposed) return;
      const original = await readClipboardText();
      if (disposed) return;
      if (revision !== inputRevision) { onError(); return; }
      applyingPaste = true;
      try { paste(exactTerminalPasteText(text, original)); }
      finally { applyingPaste = false; }
    }).catch(() => { if (!disposed) onError(); });
  };
  element.addEventListener('paste', handlePaste, true);
  return () => { disposed = true; inputSubscription.dispose(); element.removeEventListener('paste', handlePaste, true); };
}

export async function copyTerminalText(text: string): Promise<void> {
  try {
    await writeClipboardText(text);
  } catch {
    const message = t('terminal.feedback.copyFailed');
    const store = useToastStore.getState();
    if (!store.toasts.some((toast) => toast.variant === 'error' && toast.message === message)) {
      store.addToast(message, 'error');
    }
  }
}
