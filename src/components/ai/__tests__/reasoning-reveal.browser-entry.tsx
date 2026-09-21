import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiConversationNodeList, aiAskConversationNodeRenderers } from '../workspace/ai-conversation-node-seat';
import type { AiConversationNodeOf } from '@/lib/ai/conversation-node';
import { initI18n } from '@/locales';
import '@/styles/base.css';
import '../styles/styles.css';

await initI18n('en-US');
const root = createRoot(document.getElementById('root')!);
let revision = 1;
export function show(content: string, mode: 'agent' | 'ask', streaming: boolean, key: number) {
  const node: AiConversationNodeOf<'reasoning'> = {
    kind: 'reasoning', key: 'reasoning-reveal', sourceKind: 'agent',
    sessionId: 'reasoning-reveal', turnId: 'turn', stepId: 'step', requestId: 'request',
    firstSeq: 1, lastSeq: ++revision, timestamp: '2026-09-21T00:00:00.000Z',
    summary: '', content, state: streaming ? 'streaming' : 'completed',
  };
  flushSync(() => root.render(
    <main className="ai-panel-shell min-h-dvh w-full min-w-0 p-3" data-ai-scope="workbench">
      <AiConversationNodeList key={key} nodes={[node]}
        renderers={mode === 'ask' ? aiAskConversationNodeRenderers : undefined} />
    </main>,
  ));
}
