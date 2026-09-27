import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AiWorkspaceRoot } from '../workspace/ai-workspace-root';
import { AiConversation } from '../workspace/ai-conversation';
import { createAiComposerState } from '@/lib/ai/composer-machine';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import { taskTokenBudgetView } from '@/test/fixtures/task-token-budget';
import type { AgentSessionEvent } from '@/types/agent-session';
import capture from '@/test/fixtures/agent-skills-runtime.json';
import { initI18n } from '@/locales';
import '@/styles/base.css';
import '../styles/styles.css';

export async function mount(host: HTMLElement) {
  await initI18n('zh-CN');
  const root = createRoot(host);
  const context = {};
  const view = taskTokenBudgetView();
  const user = view.nodes.find(node => node.kind === 'userMessage');
  if (!user) throw new Error('Recorded user input is required');
  const events = capture as unknown as AgentSessionEvent[];
  return {
    session(stage: 'pending' | 'receipt' | 'committed' | 'navigation') {
      flushSync(() => root.render(<AiWorkspaceRoot scope="workbench"
        submissionContext={stage === 'navigation' ? {} : context}
        view={stage === 'committed' || stage === 'navigation' ? view : null}
        pendingNodes={[user]} composerState={createAiComposerState({
          sessionId: stage === 'pending' ? null : view.summary.id,
          phase: stage === 'pending' || stage === 'receipt' ? 'submitting' : 'idle',
        })} />));
    },
    prefix(length: number) {
      flushSync(() => root.render(<AiConversation
        nodes={projectAgentChatNodes(events.slice(0, length)).filter(node => node.kind !== 'systemPrompt')}
        status="running" throughSeq={events[length - 1]?.seq ?? null} />));
    },
    firstVisibleProcess: events.findIndex((_, index) => projectAgentChatNodes(events.slice(0, index + 1))
      .some(node => node.kind === 'turnProcess' && node.children.some(child => child.kind === 'contextInjection'
        && child.provenance.kind === 'skill-invocation'))),
  };
}
