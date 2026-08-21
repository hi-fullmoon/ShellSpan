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
    render(<AgentRunView run={run} onApprove={onApprove} onReject={vi.fn()} canInsert />);

    expect(screen.getByText('diagnose disk usage')).toBeInTheDocument();
    expect(screen.getByText('df -h')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ai.agent.approveInsert' }));
    expect(onApprove).toHaveBeenCalledWith(run.steps[1]);
  });

  it('disables insertion when the bound terminal is no longer active', () => {
    render(<AgentRunView run={run} onApprove={vi.fn()} onReject={vi.fn()} canInsert={false} />);
    expect(screen.getByRole('button', { name: 'ai.agent.approveInsert' })).toBeDisabled();
  });
});
