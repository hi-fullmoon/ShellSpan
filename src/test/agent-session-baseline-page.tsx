import React from 'react';
import ReactDOM from 'react-dom/client';

import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import '@/components/ai/ai-panel.css';
import { projectAgentActivity } from '@/lib/ai/agent-session-projection';
import { projectAgentChatNodes } from '@/lib/ai/conversation-projection';
import type { AiSessionView } from '@/lib/ai/session-adapter';
import { applyTheme } from '@/lib/theme';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentSessionBaselineScenario } from './fixtures/agent-session-baseline';
import {
  AGENT_BASELINE_VISUAL,
  agentSessionBaselineScenario,
} from './fixtures/agent-session-baseline';

export function agentSessionBaselineView(scenario: AgentSessionBaselineScenario): AiSessionView {
  const last = scenario.events[scenario.events.length - 1];
  const first = scenario.events[0];
  const ended = scenario.status !== 'running';
  return {
    summary: {
      id: scenario.sessionId,
      kind: 'agent',
      title: scenario.title,
      updatedAt: new Date(last?.timeUnixMs ?? first?.timeUnixMs ?? 0).toISOString(),
      status: scenario.status,
      scopeKey: 'baseline-workbench',
      archived: false,
    },
    snapshot: {
      kind: 'agent',
      value: {
        header: {
          sessionId: scenario.sessionId,
          taskId: scenario.taskId,
          goal: scenario.title,
          target: scenario.events.find((event) => event.type === 'session/created')?.data.target,
          permissionMode: scenario.modelInput.permission,
          createdAtUnixMs: first?.timeUnixMs ?? 0,
        },
        status: scenario.status,
        ended,
        archived: false,
        eventCount: scenario.events.length,
        surface: { generation: 0, messages: [] },
        inbox: { nextTurn: [], nextStep: [] },
        task: { evidence: [] },
        recovery: {
          kind: ended ? 'terminal' : 'openModelRequest',
          status: 'none',
          summary: 'Phase 0 deterministic fixture',
          lastCommittedSeq: last?.seq ?? 0,
        },
      },
    },
    nodes: projectAgentChatNodes(scenario.events),
    activityNodes: projectAgentActivity(scenario.events).nodes,
    inbox: [],
    pendingApproval: null,
    status: scenario.status,
    error: null,
    throughSeq: last?.seq ?? null,
    canLoadOlder: Boolean(scenario.pages?.older.length),
  };
}

function BaselinePage({ scenario }: { readonly scenario: AgentSessionBaselineScenario }): React.ReactNode {
  return (
    <main
      data-baseline-ready="true"
      data-baseline-scenario={scenario.id}
      data-baseline-fixture-version={scenario.fixtureVersion}
      style={{
        width: AGENT_BASELINE_VISUAL.viewport.width,
        height: AGENT_BASELINE_VISUAL.viewport.height,
        display: 'flex',
        justifyContent: 'flex-end',
        background: 'var(--app-bg)',
        overflow: 'hidden',
      }}
    >
      <script
        type="application/json"
        data-baseline-fixture=""
        dangerouslySetInnerHTML={{ __html: JSON.stringify(scenario).replace(/</g, '\\u003c') }}
      />
      <aside
        className="ai-panel-shell"
        data-ai-scope="workbench"
        data-baseline-surface="shellspan-ai-panel"
        aria-label="ShellSpan AI Panel Phase 0 baseline"
        style={{ width: AGENT_BASELINE_VISUAL.surface.width, height: AGENT_BASELINE_VISUAL.surface.height }}
      >
        <AiWorkspaceRoot
          view={agentSessionBaselineView(scenario)}
          scope="workbench"
          providerLabel={scenario.modelInput.provider}
          modelLabel={scenario.modelInput.model}
          canStartAgent
        />
      </aside>
    </main>
  );
}

export async function mountAgentSessionBaselinePage(root: HTMLElement): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const scenario = agentSessionBaselineScenario(params.get('aiPhase0Baseline'));
  const theme = params.get('theme') === 'dark' ? 'dark' : AGENT_BASELINE_VISUAL.theme;
  useAppStore.setState({ locale: AGENT_BASELINE_VISUAL.locale, theme });
  await initI18n(AGENT_BASELINE_VISUAL.locale);
  applyTheme(theme);
  document.documentElement.style.fontSize = `${AGENT_BASELINE_VISUAL.fontScale * 100}%`;
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <BaselinePage scenario={scenario} />
    </React.StrictMode>,
  );
}
