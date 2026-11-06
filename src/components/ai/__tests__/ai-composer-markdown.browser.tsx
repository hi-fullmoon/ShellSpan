import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiComposerSeat } from '../workspace/ai-composer-seat';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { decodeDocumentMessage } from '@/lib/ai/document-message';
import '@/styles/base.css';
import '../styles/styles.css';

const locale = new URLSearchParams(location.search).get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US';
useAppStore.setState({ locale });
await initI18n(locale);

function Composer() {
  const [draft, setDraft] = useState('');
  return <main className="ai-panel-shell mx-auto flex h-dvh max-w-3xl flex-col justify-end bg-background">
    <AiComposerSeat phase="active" status="idle" draft={draft} onDraftChange={setDraft}
      onSubmit={value => { document.body.dataset.submitted = decodeDocumentMessage(value).text; }} />
    <output hidden data-draft={decodeDocumentMessage(draft).text} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Composer />);
