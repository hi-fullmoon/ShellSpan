import { createRoot } from 'react-dom/client';
import { AiQueueDock } from '@/components/ai/workspace/ai-queue-dock';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import '@/styles/base.css';
import '@/components/ai/styles/styles.css';

const params = new URLSearchParams(location.search);
const locale = params.get('locale') === 'en-US' ? 'en-US' : 'zh-CN';
useAppStore.setState({ locale });
await initI18n(locale);

// Replay the runtime error captured in the user's screenshot through the real UI.
createRoot(document.getElementById('root')!).render(<AiQueueDock items={[{
  id: '1278', content: '12', lane: 'nextTurn', state: 'queued', source: 'user',
}]} mutation={{
  intent: { type: 'remove', itemId: '1278' },
  status: 'failed', conflict: true,
  error: 'Agent Runtime revision conflict: expected revision 1278, current revision 1279',
}} />);
