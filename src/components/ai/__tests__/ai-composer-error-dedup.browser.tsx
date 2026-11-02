import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { TooltipProvider } from '@/components/ui/tooltip';
import { createAiComposerState, reduceAiComposer } from '@/lib/ai/composer-machine';
import { AiPreparationTimeoutError, normalizeAiSessionError } from '@/lib/ai/session-error';
import { withOptimisticConversationNodes, withRetainedFailedSubmissions, type AiOptimisticSubmission } from '@/lib/ai/optimistic-submission';
import { AiSubmissionMemory } from '@/lib/ai/submission-memory';
import { taskTokenBudgetView } from '@/tests/fixtures/task-token-budget';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import '@/styles/base.css';
import '../styles/styles.css';

const locale = new URLSearchParams(location.search).get('locale') === 'en-US' ? 'en-US' : 'zh-CN';
useAppStore.setState({ locale });
await initI18n(locale);
const host = document.getElementById('error-dedup-check')!;
const recorded = taskTokenBudgetView();
let state = createAiComposerState({ sessionId: recorded.summary.id });
const submissions: AiOptimisticSubmission[] = [];
// Exercise real reducer transitions without replacing any service or transport.
for (let index = 0; index < 3; index++) {
  const clientOperationId = `${recorded.summary.id}:${index}`;
  state = reduceAiComposer(state, { type: 'submit.requested', clientOperationId,
    content: recorded.snapshot.value.header.goal, gesture: 'primary', accelerated: false,
    now: recorded.snapshot.value.header.createdAtUnixMs + index, hasProvider: true, canCreateSession: true }).state;
  submissions.push({ ...state.pendingSubmissions[0], scopeKey: recorded.summary.scopeKey,
    expectedNextSeq: null, delivery: 'failed' });
  state = reduceAiComposer(state, { type: 'submit.failed', clientOperationId,
    error: normalizeAiSessionError(new AiPreparationTimeoutError()) }).state;
}
const nodes = withOptimisticConversationNodes([], submissions, recorded.summary.scopeKey, recorded.summary.id);
const memory = new AiSubmissionMemory();
const context = { key: recorded.summary.scopeKey };
memory.remember(context, state);
memory.close(context);
function Review() {
  const [visit, setVisit] = useState(0);
  const restored = visit > 0 ? memory.reopen(context.key)?.state : undefined;
  const pendingNodes = restored ? withOptimisticConversationNodes([], withRetainedFailedSubmissions([], restored, context.key),
    context.key, restored.sessionId) : nodes;
  return <>
    <button id="reopen-failed-messages" className="sr-only" onClick={() => setVisit(value => value + 1)}>Reopen conversation</button>
    <AiWorkspaceRoot key={visit} scope="workbench" mode="agent" view={null} composerState={restored ?? state}
      pendingNodes={pendingNodes} onRetryFailedDraft={id => { host.dataset.retried = id; }} />
  </>;
}
createRoot(host).render(<TooltipProvider><Review /></TooltipProvider>);
