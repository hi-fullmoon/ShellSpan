import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
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
  expectedNextSeq: null, delivery: 'pending', mode: 'nextTurn',
  content: 'Explain the continuation result.', createdAtUnixMs: Date.now(),
}], 'layout', null);
const root = createRoot(document.getElementById('root')!);
await initI18n('en-US');
Object.assign(window, {
  turnNodes: recorded.map(node => ({ key: node.key, kind: node.kind })),
  renderTurnPrefix(length: number) {
    flushSync(() => root.render(
      <main className="ai-panel-shell flex h-dvh min-h-0 w-full flex-col" data-ai-scope="workbench">
        <AiConversation nodes={recorded.slice(0, length)} status="running" throughSeq={null} />
      </main>,
    ));
  },
});
