import { writeClipboardText } from '@/lib/clipboard';
import { t } from '@/locales';
import { useToastStore } from '@/stores/toastStore';

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
