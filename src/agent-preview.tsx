import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/base.css';
import { AgentRunView } from './components/ai/agent-run-view';
import type { AgentRun } from './types/ai';

const run: AgentRun = {
  id: 'preview',
  requestId: 'preview-request',
  goal: 'Memory 怎么占 132.7mb',
  sessionId: 'preview-session',
  contextLabel: 'root@175.178.66.45',
  contextSource: 'terminal',
  contextObservedAt: Date.now(),
  phase: 'planning',
  responseText: 'Planning',
  steps: [
    {
      id: 'context',
      kind: 'tool',
      title: 'terminal.getContext',
      description: 'root@175.178.66.45',
      status: 'completed',
    },
    {
      id: 'plan',
      kind: 'analysis',
      title: 'diagnosticAgent.plan',
      description: '',
      status: 'running',
    },
  ],
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <main className="h-screen w-[420px] border-r border-border bg-background">
    <div className="flex h-full flex-col">
      <AgentRunView
        run={run}
        onCancel={() => {}}
        onRetry={() => {}}
        onReviewRunbook={() => {}}
      />
    </div>
  </main>,
);
