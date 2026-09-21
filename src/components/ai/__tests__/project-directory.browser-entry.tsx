import { createRoot } from 'react-dom/client';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import '@/styles/base.css';
import '../styles/styles.css';

useAppStore.setState({ locale: 'en-US' });
await initI18n('en-US');
createRoot(document.getElementById('root')!).render(
  <main className="ai-panel-shell p-3">
    <AiComposerSeat phase="active" status="idle" skillsNeedsRoot projectTargetLabel="Local filesystem"
      onListProjectDirectories={async (query, signal) => {
        const response = await fetch(`/directories?q=${encodeURIComponent(query)}`, { signal });
        if (!response.ok) throw new Error('Unavailable');
        return response.json();
      }} />
  </main>,
);
