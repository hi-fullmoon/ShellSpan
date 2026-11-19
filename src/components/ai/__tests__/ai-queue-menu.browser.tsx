import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiComposerSeat } from '@/components/ai/workspace/ai-composer-seat';
import type { AiInboxItem } from '@/lib/ai/session-adapter';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import '@/styles/base.css';
import '@/components/ai/styles/styles.css';

const locale = new URLSearchParams(location.search).get('locale') === 'en-US' ? 'en-US' : 'zh-CN';
useAppStore.setState({ locale });
await initI18n(locale);

function Queue() {
  // Reproduce the two user inputs shown in the reported screenshot.
  const [items, setItems] = useState<AiInboxItem[]>(['hello', '年后'].map(content => ({
    id: content, content, lane: 'nextStep', state: 'queued', source: 'user',
  })));
  return <AiComposerSeat phase="active" status="waiting" inbox={items}
    onUpdateQueueItem={async (item, content) => {
      setItems(current => current.map(candidate => candidate.id === item.id ? { ...candidate, content } : candidate));
      return true;
    }}
    onRemoveQueueItem={item => setItems(current => current.filter(candidate => candidate.id !== item.id))}
    onReorderQueueLane={(_lane, ids) => {
    setItems(current => ids.map(id => {
      const item = current.find(candidate => candidate.id === id);
      if (!item) throw new Error(`Unknown queue item: ${id}`);
      return item;
    }));
  }} />;
}

createRoot(document.getElementById('root')!).render(<Queue />);
