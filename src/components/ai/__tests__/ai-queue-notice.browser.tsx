import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiComposerSeat } from '@/components/ai/workspace/ai-composer-seat';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import '@/styles/base.css';
import '@/components/ai/styles/styles.css';

const params = new URLSearchParams(location.search);
const locale = params.get('locale') === 'en-US' ? 'en-US' : 'zh-CN';
useAppStore.setState({ locale });
await initI18n(locale);

// Replay the runtime error captured in the user's screenshot through the real UI.
const host = document.getElementById('root')!;
const root = createRoot(host);
export function showQueueNotice(status: 'failed' | 'retrying' | null) {
  flushSync(() => root.render(<AiComposerSeat mode="agent" phase="active" status="idle"
    inbox={[{ id: '1278', content: '12', lane: 'nextTurn', state: 'queued', source: 'user' }]}
    queueMutation={status && {
      intent: { type: 'remove', itemId: '1278' }, status, conflict: true,
      error: 'Agent Runtime revision conflict: expected revision 1278, current revision 1279',
    }} onRetryQueueMutation={async () => { showQueueNotice('retrying'); return false; }} />));
}

showQueueNotice('failed');
