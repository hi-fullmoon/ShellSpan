import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from '@/lib/tauri';

export const PETDEX_PHASE3_FEEDBACK_URL = 'https://github.com/hi-fullmoon/TermBridge/issues/new?template=petdex-phase3-feedback.yml';

export async function openPetdexPhase3Feedback(): Promise<void> {
  if (isTauriRuntime()) {
    await invoke('open_url', { url: PETDEX_PHASE3_FEEDBACK_URL });
    return;
  }
  window.open(PETDEX_PHASE3_FEEDBACK_URL, '_blank', 'noopener,noreferrer');
}
