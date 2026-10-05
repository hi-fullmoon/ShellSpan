import { invokeOpenUrl, isTauriRuntime } from '@/lib/ipc/tauri';

export const FEEDBACK_URL = 'https://github.com/hi-fullmoon/ShellSpan/issues/new';

export async function openFeedback(): Promise<void> {
  if (isTauriRuntime()) {
    await invokeOpenUrl(FEEDBACK_URL);
    return;
  }
  window.open(FEEDBACK_URL, '_blank', 'noopener,noreferrer');
}
