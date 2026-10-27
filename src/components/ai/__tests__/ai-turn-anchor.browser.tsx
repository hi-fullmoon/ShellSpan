import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useReducer, useState } from 'react';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { createAiComposerState, reduceAiComposer, type AiComposerEvent } from '@/lib/ai/composer-machine';
import { AiConversation } from '../workspace/ai-conversation';
import { Message, MessageScroller } from '../chat-primitives';
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
function ExistingComposer() {
  const sessionId = history[0].sessionId;
  const [state, dispatch] = useReducer((previous: ReturnType<typeof createAiComposerState>, event: AiComposerEvent) =>
    reduceAiComposer(previous, event).state, undefined,
  () => createAiComposerState({ sessionId, runtimeStatus: 'completed' }));
  const submissions = state.pendingSubmissions.map(item => ({ ...item, scopeKey: 'layout',
    expectedNextSeq: null, delivery: item.state === 'confirming' ? 'confirming' as const : 'pending' as const }));
  const nodes = withOptimisticConversationNodes(history, submissions, 'layout', sessionId);
  return <main className="flex h-dvh min-h-0 flex-col">
    <AiWorkspaceRoot scope="workbench" mode="agent" view={null} pendingNodes={nodes} composerState={state}
      onDraftChange={value => dispatch({ type: 'draft.changed', value })}
      onSubmitGesture={(gesture, accelerated) => dispatch({ type: 'submit.requested', gesture, accelerated,
        clientOperationId: crypto.randomUUID(), now: Date.now(), hasProvider: true, canCreateSession: true })} />
  </main>;
}
function PagedHistory() {
  const [start, setStart] = useState(Math.max(1, Math.floor(history.length / 2)));
  return <main className="ai-workspace-root ai-panel-shell flex h-dvh min-h-0 w-full flex-col" data-ai-scope="workbench">
    <AiConversation nodes={history.slice(start)} status="completed" throughSeq={null}
      canLoadOlder={start > 0} onLoadOlder={() => setStart(current => Math.max(0, current - 1))} />
  </main>;
}
await initI18n('en-US');
Object.assign(window, {
  renderScrollingDocument(text: string, generating: boolean) {
    flushSync(() => root.render(
      <main className="ai-workspace-root ai-panel-shell flex h-dvh min-h-0 w-full flex-col" data-ai-scope="workbench">
        <MessageScroller followKey={text} generating={generating}>
          <Message role="assistant"><div className="whitespace-pre-wrap">{text}</div></Message>
        </MessageScroller>
      </main>,
    ));
  },
  renderExistingComposer() { flushSync(() => root.render(<ExistingComposer />)); },
  recordedEventTypes: taskTokenBudgetEvidence.continuedEvents.map(event => event.type),
  recordedUserIndices: taskTokenBudgetEvidence.continuedEvents.flatMap((event, index) =>
    event.type === 'user/message' && event.data.message.source.kind === 'user' ? [index] : []),
  renderRecordedEvents(length: number, status: 'running' | 'completed' = 'running', submitting = false) {
    const events = taskTokenBudgetEvidence.continuedEvents;
    const next = events[length];
    const projected = projectAgentChatNodes(events.slice(0, length));
    const nodes = submitting && next?.type === 'user/message'
      ? withOptimisticConversationNodes(projected, [{
        clientOperationId: next.data.message.clientSubmissionId ?? next.data.message.messageId,
        sessionId: next.sessionId, scopeKey: 'layout', expectedNextSeq: next.seq,
        delivery: 'pending', mode: 'nextTurn', startsTurn: true,
        content: next.data.message.content, createdAtUnixMs: next.timeUnixMs,
      }], 'layout', next.sessionId)
      : projected;
    flushSync(() => root.render(
      <main className="ai-workspace-root ai-panel-shell flex h-dvh min-h-0 w-full flex-col" data-ai-scope="workbench">
        <AiConversation nodes={nodes} status={status} throughSeq={null} />
      </main>,
    ));
  },
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
      <main className="ai-workspace-root ai-panel-shell flex h-dvh min-h-0 w-full flex-col" data-ai-scope="workbench">
        <AiConversation nodes={nodes} status="running" throughSeq={null} canLoadOlder={canLoadOlder} />
      </main>,
    ));
  },
  turnNodes: recorded.map(node => ({ key: node.key, kind: node.kind })),
  renderTurnPrefix(length: number, status: 'running' | 'completed' = 'running') {
    flushSync(() => root.render(
      <main className="ai-workspace-root ai-panel-shell flex h-dvh min-h-0 w-full flex-col" data-ai-scope="workbench">
        <AiConversation nodes={recorded.slice(0, length)} status={status} throughSeq={null} />
      </main>,
    ));
  },
});
