import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { StaticDiagnosticRun } from '@/types/ai';
import { AgentRunView } from '../agent-run-view';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

const plan: NonNullable<StaticDiagnosticRun['plan']> = {
  objective: 'Reload nginx safely',
  target: 'The bound production host only',
  assumptions: ['nginx is managed by systemd'],
  summary: 'Fresh status evidence is required before reload.',
  evidence: [
    {
      id: 'terminal-context',
      description: 'Original context',
      source: 'context',
      sourceStepId: null,
      maxAgeSeconds: 120,
    },
    {
      id: 'service-output',
      description: 'Fresh status output',
      source: 'stepOutput',
      sourceStepId: 'check-service',
      maxAgeSeconds: 60,
    },
  ],
  steps: [
    {
      id: 'check-service',
      title: 'Check nginx',
      description: 'Collect fresh status.',
      command: 'systemctl status nginx',
      risk: 'readOnly',
      evidenceIds: ['terminal-context'],
      impact: 'Reads status on one host.',
      rollback: 'No mutation is performed.',
      expected: { exitCode: 0, stdoutContains: [] },
      timeoutSeconds: 15,
      safeToRetry: true,
    },
    {
      id: 'reload-service',
      title: 'Reload nginx',
      description: 'Reload after fresh evidence.',
      command: 'sudo systemctl reload nginx',
      risk: 'stateChange',
      evidenceIds: ['service-output'],
      impact: 'Reloads nginx on one reviewed host.',
      rollback: 'Restore the previous configuration and reload again.',
      expected: { exitCode: 0, stdoutContains: [] },
      timeoutSeconds: 30,
      safeToRetry: false,
    },
  ],
};

const run: StaticDiagnosticRun = {
  id: 'run-1',
  requestId: 'request-1',
  goal: 'diagnose nginx',
  sessionId: 'session-1',
  profileId: 'profile-1',
  contextLabel: 'root@server',
  contextSource: 'terminal',
  contextObservedAt: Date.now(),
  phase: 'awaitingReview',
  summary: plan.summary,
  plan,
  responseText: '',
  steps: plan.steps.map((step) => ({
    ...step,
    kind: 'command' as const,
    status: 'informational' as const,
  })),
};

function renderView(value: StaticDiagnosticRun | undefined, overrides?: {
  onCancel?: () => void;
  onRetry?: () => void;
  onReviewRunbook?: () => void;
}) {
  return render(
    <AgentRunView
      run={value}
      onCancel={overrides?.onCancel ?? vi.fn()}
      onRetry={overrides?.onRetry ?? vi.fn()}
      onReviewRunbook={overrides?.onReviewRunbook ?? vi.fn()}
    />,
  );
}

describe('AgentRunView', () => {
  it('introduces the evidence-first workflow before a run starts', () => {
    const { container } = renderView(undefined);
    expect(screen.getByText('ai.agent.emptyTitle')).toBeInTheDocument();
    expect(screen.getByText('ai.agent.empty')).toBeInTheDocument();
    expect(screen.getByText('ai.agent.emptyStage.observe')).toBeInTheDocument();
    expect(screen.getByText('ai.agent.emptyStage.reason')).toBeInTheDocument();
    expect(screen.getByText('ai.agent.emptyStage.review')).toBeInTheDocument();
    expect(screen.getByText('ai.agent.emptyBoundary')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="message-scroller"]')).not.toBeInTheDocument();
  });

  it('shows objective, target, evidence provenance, risk, impact, and rollback', () => {
    renderView(run);
    expect(screen.getByLabelText('ai.agent.progressLabel')).toBeInTheDocument();
    expect(screen.getByText('ai.agent.path')).toBeInTheDocument();
    expect(screen.getByText('Reload nginx safely')).toBeInTheDocument();
    expect(screen.getByText(/The bound production host only/)).toBeInTheDocument();
    expect(screen.getByText('Original context')).toBeInTheDocument();
    expect(screen.getByText('Fresh status output')).toBeInTheDocument();
    expect(screen.getByText('sudo systemctl reload nginx')).toBeInTheDocument();
    expect(screen.getByText(/Restore the previous configuration/)).toBeInTheDocument();
  });

  it('marks old context as stale without authorizing a modification', () => {
    renderView({ ...run, contextObservedAt: Date.now() - 121_000 });
    expect(screen.getByText('ai.agent.evidenceStale')).toBeInTheDocument();
    expect(screen.getByText('ai.agent.evidencePending')).toBeInTheDocument();
  });

  it('hands the draft to Runbook only after an explicit review action', () => {
    const onReviewRunbook = vi.fn();
    renderView(run, { onReviewRunbook });
    expect(onReviewRunbook).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ai.agent.reviewRunbook' }));
    expect(onReviewRunbook).toHaveBeenCalledOnce();
  });

  it('allows cancellation only while the model is still planning', () => {
    const onCancel = vi.fn();
    renderView({ ...run, plan: undefined, phase: 'planning', steps: [] }, { onCancel });
    fireEvent.click(screen.getByRole('button', { name: 'ai.agent.stopRun' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
