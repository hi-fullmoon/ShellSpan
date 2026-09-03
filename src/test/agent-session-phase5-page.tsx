import React from 'react';
import ReactDOM from 'react-dom/client';

import '@/components/ai/ai-panel.css';
import { AiWorkspaceRoot } from '@/components/ai/workspace/ai-workspace-root';
import { applyTheme } from '@/lib/theme';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import type { AgentSessionEvent } from '@/types/agent-session';
import { agentSessionBaselineView } from './agent-session-baseline-page';
import {
  AGENT_BASELINE_TIME_UNIX_MS,
  agentSessionBaselineScenario,
  type AgentSessionBaselineScenario,
} from './fixtures/agent-session-baseline';

const RUNTIME_CONTEXT_SOURCE = {
  kind: 'runtime',
  label: 'ShellSpan Runtime',
  producerId: 'shellspan-runtime',
} as const;

function phase5Scenario(base: AgentSessionBaselineScenario): AgentSessionBaselineScenario {
  const userIndex = base.events.findIndex((event) => (
    event.type === 'user/message' && event.data.message.source.kind === 'user'
  ));
  const userEvent = base.events[userIndex];
  if (userIndex < 0 || userEvent?.type !== 'user/message') return base;
  const contextEvent = {
    version: userEvent.version,
    sessionId: base.sessionId,
    seq: userEvent.seq + 1,
    timeUnixMs: userEvent.timeUnixMs + 100,
    type: 'user/message',
    turnId: userEvent.turnId,
    stepId: userEvent.stepId,
    data: {
      message: {
        messageId: `message-runtime-context-${base.id}`,
        content: base.modelInput.context,
        source: RUNTIME_CONTEXT_SOURCE,
      },
    },
  } satisfies AgentSessionEvent;
  const events = [
    ...base.events.slice(0, userIndex + 1),
    contextEvent,
    ...base.events.slice(userIndex + 1),
  ].map((event, index) => {
    const seq = (base.events[0]?.seq ?? 0) + index;
    return {
    ...event,
    seq,
    timeUnixMs: AGENT_BASELINE_TIME_UNIX_MS + seq * 100,
    };
  }) as readonly AgentSessionEvent[];
  return { ...base, events, pages: undefined };
}

function Phase5Page({ scenario }: { readonly scenario: AgentSessionBaselineScenario }): React.ReactNode {
  return (
    <main
      data-phase5-ready="true"
      data-phase5-scenario={scenario.id}
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        background: 'var(--app-bg)',
        overflow: 'hidden',
      }}
    >
      <aside
        className="ai-panel-shell"
        data-ai-scope="workbench"
        data-phase5-surface="shellspan-ai-panel"
        aria-label="ShellSpan AI Panel Phase 5 visual regression"
        style={{ width: '100%', height: '100%' }}
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

export async function mountAgentSessionPhase5Page(root: HTMLElement): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const scenario = phase5Scenario(agentSessionBaselineScenario(params.get('aiPhase5Visual')));
  const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  useAppStore.setState({ locale: 'zh-CN', theme });
  await initI18n('zh-CN');
  applyTheme(theme);
  document.documentElement.lang = 'zh-CN';
  document.documentElement.style.fontSize = '100%';
  document.body.style.margin = '0';
  document.body.style.overflow = 'hidden';
  ReactDOM.createRoot(root).render(<Phase5Page scenario={scenario} />);
}
