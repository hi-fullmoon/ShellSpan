import { createRoot } from 'react-dom/client';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import '@/styles/base.css';
import '../styles/styles.css';

useAppStore.setState({ locale: 'en-US' });
await initI18n('en-US');
createRoot(document.getElementById('root')!).render(
  <main className="ai-panel-shell p-3" style={{ paddingTop: 400 }}>
    <AiComposerSeat phase="active" status="idle"
      skillsNeedsRoot={location.search.includes('needsRoot')}
      onListFileReferences={async (query, signal) => {
        const response = await fetch(`/project-entries?q=${encodeURIComponent(query)}`, { signal });
        return response.json();
      }} />
  </main>,
);
