import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { AiComposerSeat } from '@/components/ai/workspace/ai-composer-seat';
import { AiImageDraftControls } from '@/components/ai/workspace/ai-image-attachments';
import { useImageDraft } from '@/components/ai/workspace/use-image-draft';
import type { AiQueueMutationState } from '@/components/ai/workspace/use-ai-session-controller';
import { projectAgentInbox } from '@/lib/ai/agent-session-adapter';
import { normalizeAiSessionError } from '@/lib/ai/session-error';
import { invokeMutateAgentRuntimeInbox } from '@/lib/ipc/tauri';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentInboxMutation, AgentSessionEvent, AgentSessionSnapshot } from '@/types/agent-session';
import '@/styles/base.css';
import '@/components/ai/styles/styles.css';

const params = new URLSearchParams(location.search);
const locale = params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US';
const sessionId = params.get('session')!;
useAppStore.setState({ locale });
await initI18n(locale);

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const response = await fetch('/__queue_rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command, args }),
  });
  const data: { value: T; error?: string } = await response.json();
  if (data.error) throw new Error(data.error);
  return data.value;
}

function readQueue() {
  return invoke<{ snapshot: AgentSessionSnapshot; events: AgentSessionEvent[] }>('read_fixture', { input: { sessionId } });
}

const initial = await readQueue();

function QueueReview() {
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState('');
  const [mutation, setMutation] = useState<AiQueueMutationState | null>(null);
  const [failedOperationId, setFailedOperationId] = useState<string>();

  // The browser has no desktop window or drag events. Attach the real Runtime
  // command transport after mounting so the browser can exercise the other IPC.
  useEffect(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke } });
    return () => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); };
  }, []);
  const images = useImageDraft(sessionId, draft, setDraft);

  async function update(intent: AgentInboxMutation, clientOperationId: string = crypto.randomUUID()) {
    setMutation({ intent, status: 'pending', error: null, conflict: false });
    try {
      await invokeMutateAgentRuntimeInbox({
        sessionId, clientOperationId, expectedRevision: view.snapshot.eventCount, mutation: intent,
      });
      setView(await readQueue());
      setMutation(null);
      return true;
    } catch (error) {
      const normalized = normalizeAiSessionError(error);
      const conflict = normalized.kind === 'conflict';
      if (conflict) setView(await readQueue());
      setFailedOperationId(clientOperationId);
      setMutation({ intent, status: 'failed', error: normalized.message, conflict });
      return false;
    }
  }

  return <AiComposerSeat mode="agent" phase="active" status={view.snapshot.status}
    currentSessionId={sessionId} inbox={projectAgentInbox(view.events)}
    draft={draft} onDraftChange={setDraft} onPasteImages={images.add}
    imageControls={images.draft?.images.length ? <AiImageDraftControls state={images} /> : undefined}
    hasImages={Boolean(images.draft?.images.length)} imageBusy={images.busy}
    queueMutation={mutation} onDiscardQueueEdit={() => setMutation(null)}
    onUpdateQueueItem={(item, content, editedImages) => update(editedImages
      ? { type: 'updateWithImages', itemId: item.id, content, images: editedImages }
      : { type: 'update', itemId: item.id, content })}
    onRetryQueueMutation={async () => mutation?.status === 'failed' && update(mutation.intent, failedOperationId)} />;
}

createRoot(document.getElementById('root')!).render(<QueueReview />);
