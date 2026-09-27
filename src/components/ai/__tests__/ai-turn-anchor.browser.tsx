import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useState } from 'react';
import { AiConversation } from '../workspace/ai-conversation';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { taskTokenBudgetEvidence } from '@/test/fixtures/task-token-budget';
import { initI18n } from '@/locales';
import { withOptimisticConversationNodes } from '@/lib/ai/optimistic-submission';
import '@/styles/base.css';
import '../styles/styles.css';

// Replay recorded runtime nodes through the real conversation, without IPC,
// substituted geometry or observers. Each prefix represents a received batch.
const history = projectAgentChatNodes(taskTokenBudgetEvidence.continuedEvents);
// Submit an actual test prompt through the production optimistic projection.
// The transport is deliberately not invoked by this layout test.
const recorded = withOptimisticConversationNodes(history, [{
  clientOperationId: crypto.randomUUID(), sessionId: null, scopeKey: 'layout',
  expectedNextSeq: null, delivery: 'pending', mode: 'nextTurn', startsTurn: true,
  content: 'Explain the continuation result.', createdAtUnixMs: Date.now(),
}], 'layout', null);
const root = createRoot(document.getElementById('root')!);
function PagedHistory() {
  const [start, setStart] = useState(Math.max(1, Math.floor(history.length / 2)));
  return <main className="ai-panel-shell flex h-dvh min-h-0 w-full flex-col" data-ai-scope="workbench">
    <AiConversation nodes={history.slice(start)} status="completed" throughSeq={null}
      canLoadOlder={start > 0} onLoadOlder={() => setStart(current => Math.max(0, current - 1))} />
  </main>;
}
await initI18n('en-US');
Object.assign(window, {
  renderPagedHistory() {
    flushSync(() => root.render(<PagedHistory />));
  },
  renderDocumentTurn(text: string, submitted: boolean, canLoadOlder = false) {
    const nodes = withOptimisticConversationNodes(history, [{
      clientOperationId: 'document-question', sessionId: null, scopeKey: 'layout',
      expectedNextSeq: null, delivery: 'pending', mode: 'nextTurn', startsTurn: true,
      content: text, createdAtUnixMs: 0,
    }, ...(submitted ? [{
      clientOperationId: 'follow-up-question', sessionId: null, scopeKey: 'layout',
      expectedNextSeq: null, delivery: 'pending' as const, mode: 'nextTurn' as const, startsTurn: true,
      content: 'Explain this document.', createdAtUnixMs: 1,
    }] : [])], 'layout', null);
    flushSync(() => root.render(
      <main className="ai-panel-shell flex h-dvh min-h-0 w-full flex-col" data-ai-scope="workbench">
        <AiConversation nodes={nodes} status="running" throughSeq={null} canLoadOlder={canLoadOlder} />
      </main>,
    ));
  },
  turnNodes: recorded.map(node => ({ key: node.key, kind: node.kind })),
  renderTurnPrefix(length: number) {
    flushSync(() => root.render(
      <main className="ai-panel-shell flex h-dvh min-h-0 w-full flex-col" data-ai-scope="workbench">
        <AiConversation nodes={recorded.slice(0, length)} status="running" throughSeq={null} />
      </main>,
    ));
  },
});
