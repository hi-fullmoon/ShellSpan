import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '@/types/ai';
import { AgentRunView } from '../agent-run-view';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

const run: AgentRun = {
  id: 'run-1',
  requestId: 'request-1',
  goal: 'diagnose disk usage',
  sessionId: 'session-1',
  contextLabel: 'root@server',
  phase: 'awaitingApproval',
  summary: 'Disk usage needs inspection.',
  responseText: '',
  steps: [
    {
      id: 'tool-1',
      kind: 'tool',
      title: 'terminal.getContext',
      description: 'root@server',
      status: 'completed',
    },
    {
      id: 'command-1',
      kind: 'command',
      title: 'Inspect filesystems',
      description: 'Read disk usage.',
      command: 'df -h',
      status: 'awaitingApproval',
    },
  ],
};

describe('AgentRunView', () => {
  it('renders run steps and delegates explicit command approval', () => {
    const onApprove = vi.fn();
    render(
      <AgentRunView
        run={run}
        onApprove={onApprove}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onActivateSession={vi.fn()}
        canInsert
        sessionState="ready"
      />,
    );

    expect(screen.getByText('diagnose disk usage')).toBeInTheDocument();
    expect(screen.getByText('df -h')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ai.agent.approveInsert' }));
    expect(onApprove).toHaveBeenCalledWith(run.steps[1]);
  });

  it('disables insertion when the bound terminal is no longer active', () => {
    const onActivateSession = vi.fn();
    render(
      <AgentRunView
        run={run}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onActivateSession={onActivateSession}
        canInsert={false}
        sessionState="inactive"
      />,
    );
    expect(screen.getByRole('button', { name: 'ai.agent.approveInsert' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'ai.agent.switchSession' }));
    expect(onActivateSession).toHaveBeenCalledOnce();
  });

  it('waits for the instrumented command completion marker after insertion', () => {
    const insertedRun: AgentRun = {
      ...run,
      phase: 'awaitingExecution',
      steps: run.steps.map((step) => (
        step.id === 'command-1' ? { ...step, status: 'inserted' as const } : step
      )),
    };
    render(
      <AgentRunView
        run={insertedRun}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onActivateSession={vi.fn()}
        canInsert
        sessionState="ready"
      />,
    );

    expect(screen.getByText('ai.agent.waitingForCommand')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ai.agent.executedContinue' })).not.toBeInTheDocument();
  });

  it('requires confirmation that an inserted command was cleared before stopping', async () => {
    const onCancel = vi.fn();
    const insertedRun: AgentRun = {
      ...run,
      phase: 'awaitingExecution',
      steps: run.steps.map((step) => (
        step.id === 'command-1' ? { ...step, status: 'inserted' as const } : step
      )),
    };
    render(
      <AgentRunView
        run={insertedRun}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onCancel={onCancel}
        onRetry={vi.fn()}
        onActivateSession={vi.fn()}
        canInsert
        sessionState="ready"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'ai.agent.stopRun' }));
    expect(await screen.findByText('ai.agent.stopInsertedTitle')).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'ai.agent.clearedStop' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
