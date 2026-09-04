import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/components/ai/ai-panel.css';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { applyTheme } from '@/lib/theme';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type {
  AgentQuestionView,
  AnswerQuestionInput,
} from '@/types/agent-question';
import { agentSessionBaselineView } from './agent-session-baseline-page';
import { agentSessionBaselineScenario } from './fixtures/agent-session-baseline';

function QuestionPage() {
  const base = agentSessionBaselineView(agentSessionBaselineScenario('hello'));
  const [submission, setSubmission] = useState<AnswerQuestionInput | null>(
    null,
  );
  const question: AgentQuestionView = {
    identity: {
      sessionId: base.summary.id,
      turnId: 'turn-01',
      stepId: 'step-01',
      requestId: 'request-01',
      callId: 'q',
      questionRequestId: 'visual-question',
    },
    questions: Array.from({ length: 3 }, (_, i) => ({
      id: `q${i}`,
      question: `Which approach for task ${i + 1}?`,
      header: `Decision ${i + 1}`,
      multi_select: i === 1,
      options: Array.from({ length: 7 }, (_, j) => ({
        label: j === 0 ? 'Option 1 (Recommended)' : `Option ${j + 1}`,
        description:
          'A detailed option description to exercise wrapping at the narrowest supported panel width.',
      })),
    })),
    answers: submission?.answers ?? [],
    status: submission ? 'answered' : 'pending',
    firstSeq: 100,
    lastSeq: 101,
    timestamp: '2026-09-04T00:00:00Z',
  };
  return (
    <main
      className="ai-panel-shell"
      data-ai-scope="workbench"
      data-stage6a-ready="true"
      style={{ width: '100vw', height: '100vh' }}
    >
      <AiWorkspaceRoot
        view={{
          ...base,
          status: submission ? 'completed' : 'waiting',
          pendingQuestion: submission ? null : question,
          nodes: [
            ...base.nodes,
            {
              kind: 'question',
              key: 'question-visual',
              sourceKind: 'agent',
              sessionId: base.summary.id,
              turnId: 'turn-01',
              stepId: 'step-01',
              firstSeq: 100,
              lastSeq: 101,
              timestamp: question.timestamp,
              question,
            },
          ],
        }}
        scope="workbench"
        defaultDraft="ordinary unsent draft"
        canStartAgent
        onAnswerQuestion={async (input) => {
          setSubmission(input);
        }}
      />
    </main>
  );
}

export async function mountQuestionPage(root: HTMLElement): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  const locale = params.get('locale') === 'zh-CN' ? 'zh-CN' : 'en-US';
  useAppStore.setState({ locale, theme });
  await initI18n(locale);
  applyTheme(theme);
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  createRoot(root).render(<QuestionPage />);
}
