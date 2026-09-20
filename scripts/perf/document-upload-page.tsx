import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiComposerSeat } from '../../src/components/ai/workspace/ai-composer-seat';
import { AiImageDraftRail } from '../../src/components/ai/workspace/ai-image-draft-rail';
import type { AgentImageUpload } from '../../src/types/agent-image';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { initI18n } from '../../src/locales';
import { useToastStore } from '../../src/stores/toastStore';
import { useAppStore } from '../../src/stores/appStore';
import { chatReferenceFile } from '../../src/lib/ai/chat-reference';
import { documentMessageSummary } from '../../src/lib/ai/document-message';
import type { AiSessionSummary } from '../../src/lib/ai/session-adapter';
import type { AiConversationNode } from '../../src/lib/ai/conversation-node';
import '../../src/styles/base.css';
import '../../src/components/ai/styles/styles.css';

useAppStore.setState({ locale: 'en-US' });
await initI18n('en-US');
function Page() {
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState(0);
  const [mode, setMode] = useState<'ask' | 'agent'>('ask');
  const [sent, setSent] = useState('');
  const [images, setImages] = useState<AgentImageUpload[]>([]);
  const [history, setHistory] = useState<{ summary: AiSessionSummary; nodes: AiConversationNode[] }[]>([]);
  const toasts = useToastStore(state => state.toasts);
  return <TooltipProvider><main className="@container/ai-workspace flex h-screen min-w-0 flex-col justify-end">
    <button onClick={() => { setScope(value => value + 1); setDraft(''); }}>New conversation</button>
    <button onClick={() => setMode(value => value === 'ask' ? 'agent' : 'ask')}>Switch mode</button>
    <output data-testid="sent" hidden>{sent}</output>
    <div data-testid="notices">{toasts.map(toast => <p key={toast.id} data-variant={toast.variant}>{toast.message}</p>)}</div>
    <AiComposerSeat phase="active" status="idle" mode={mode} attachmentScopeKey={String(scope)}
      imageControls={images.length ? <AiImageDraftRail images={images} busy={false} locked={false} error={false} onRemove={index => setImages(items => items.filter((_, i) => i !== index))} /> : undefined}
      onPasteImages={async files => {
        const uploads = await Promise.all(files.map(async file => ({ name: file.name, mediaType: file.type,
          data: await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          }),
        })));
        setImages(items => [...items, ...uploads]);
      }}
      sessions={history.map(entry => entry.summary)} onReadSession={async summary => {
        const entry = history.find(entry => entry.summary.id === summary.id);
        if (!entry) throw new Error('Missing conversation');
        return chatReferenceFile(entry.summary, entry.nodes);
      }}
      draft={draft} onDraftChange={setDraft} onSubmit={value => {
        const id = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        setHistory(entries => [...entries, {
          summary: { id, kind: 'agent', title: documentMessageSummary(value), updatedAt: timestamp, status: 'idle', scopeKey: 'browser', archived: false },
          nodes: [{ kind: 'userMessage', key: id, sourceKind: 'agent', sessionId: id, turnId: id, stepId: null,
            firstSeq: 1, lastSeq: 1, timestamp, messageId: id, delivery: 'committed', content: value }],
        }]);
        setSent(value); setDraft('');
      }} />
  </main></TooltipProvider>;
}
createRoot(document.getElementById('root')!).render(<Page />);
