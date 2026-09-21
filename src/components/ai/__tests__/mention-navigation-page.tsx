import { createRoot } from 'react-dom/client';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import '@/styles/base.css';
import '@/components/ai/styles/styles.css';

useAppStore.setState({ locale: 'en-US' });
await initI18n('en-US');
createRoot(document.getElementById('root')!).render(
  <main className="flex h-screen flex-col justify-end p-4">
    <AiComposerSeat phase="active" status="idle" />
  </main>,
);
