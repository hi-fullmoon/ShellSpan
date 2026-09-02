import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApprovalCard } from '../agent-approval-card';
import { AgentPermissionSelector } from '../agent-permission-selector';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AgentToolApprovalSnapshot } from '@/types/agent-approval';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const initialTerminalState = useTerminalStore.getState();
const initialPermissionState = useAgentPermissionStore.getState();

function connectSession(): void {
  useTerminalStore.getState().addSession({
    sessionId: 'session-1',
    title: 'Production',
    host: 'server.example.com',
    port: 22,
    username: 'operator',
  }, 'profile-1');
  useTerminalStore.getState().setStatus('session-1', {
    sessionId: 'session-1',
    status: 'connected',
  });
}

function approvalSnapshot(): AgentToolApprovalSnapshot {
  return {
    toolCall: {
      requestId: 'request-1',
      callId: 'call-1',
      name: 'run_terminal_command',
      command: 'systemctl restart nginx --no-block',
      explanation: 'Restart nginx after reviewing the target.',
      target: {
        kind: 'remote',
        sessionId: 'session-1',
        profileId: 'profile-1',
        host: 'server.example.com',
        port: 22,
        username: 'operator',
      },
    },
    riskAssessment: { risk: 'stateChange' },
    status: 'awaitingApproval',
    approval: {
      sessionId: 'agent-session-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      requestId: 'request-1',
      callId: 'call-1',
      approvalId: 'approval-1',
    },
  };
}

describe('Agent permission and approval components', () => {
  beforeEach(() => {
    useTerminalStore.setState(initialTerminalState, true);
    useAgentPermissionStore.setState(initialPermissionState, true);
    connectSession();
  });

  it('selects safer modes directly and confirms full access with a persistent warning', async () => {
    const { container } = render(<AgentPermissionSelector sessionId="session-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'agent.permission' }));
    fireEvent.click(await screen.findByRole('menuitemradio', {
      name: /agent\.permission\.autoApproveReadOnly/,
    }));
    expect(useAgentPermissionStore.getState().getMode('session-1')).toBe('autoApproveReadOnly');

    fireEvent.click(screen.getByRole('button', { name: 'agent.permission' }));
    fireEvent.click(await screen.findByRole('menuitemradio', {
      name: /agent\.permission\.fullAccess/,
    }));
    expect(useAgentPermissionStore.getState().getMode('session-1')).toBe('autoApproveReadOnly');
    expect(await screen.findByText('agent.permission.fullAccessWarning')).toBeVisible();

    const fullAccessConfirm = screen.getByRole('button', {
      name: 'agent.permission.fullAccessConfirm',
    });
    expect(fullAccessConfirm).toHaveClass('h-8');
    expect(screen.getByRole('button', { name: 'common.cancel' })).toHaveClass('h-8');
    fireEvent.click(fullAccessConfirm);
    expect(useAgentPermissionStore.getState().getMode('session-1')).toBe('fullAccess');
    expect(await screen.findByText('agent.permission.fullAccessActive')).toBeVisible();
    expect(screen.getByText('agent.permission.fullAccessSelected')).toBeVisible();
    expect(container.querySelector('[data-slot="agent-permission-trigger-content"]')).toHaveClass(
      'text-app-warning',
    );
  });

  it('keeps full descriptions and confirmation in the compact composer variant', async () => {
    const { container } = render(
      <AgentPermissionSelector sessionId="session-1" variant="composer" />,
    );

    expect(container.querySelector('[data-slot="agent-permission-selector"]')).toHaveAttribute(
      'data-variant',
      'composer',
    );
    const trigger = screen.getByRole('button', { name: 'agent.permission' });
    expect(trigger).toHaveClass('hover:bg-accent');
    expect(trigger).not.toHaveClass('bg-secondary');
    expect(container.querySelector('[data-slot="agent-permission-trigger-content"]')).toHaveClass(
      'items-center',
      'leading-none',
    );
    fireEvent.click(trigger);
    const requestApprovalDescription = await screen.findByText(
      'agent.permission.requestApprovalDescription',
    );
    expect(screen.getByRole('menu')).toHaveClass(
      'w-96',
      'max-w-[calc(100vw-1rem)]',
    );
    expect(screen.getByRole('menuitemradio', {
      name: /agent\.permission\.requestApproval/,
    })).toHaveClass('text-[13px]');
    expect(requestApprovalDescription).toBeVisible();
    expect(requestApprovalDescription).toHaveClass(
      'text-[11px]',
      'leading-4',
      'sm:whitespace-nowrap',
    );
    fireEvent.click(screen.getByRole('menuitemradio', {
      name: /agent\.permission\.fullAccess/,
    }));
    expect(await screen.findByText('agent.permission.fullAccessWarning')).toBeVisible();

    fireEvent.click(screen.getByRole('button', {
      name: 'agent.permission.fullAccessConfirm',
    }));
    expect(useAgentPermissionStore.getState().getMode('session-1')).toBe('fullAccess');
    expect(screen.queryByText('agent.permission.fullAccessActive')).not.toBeInTheDocument();
  });

  it('returns to the default and disables elevation after disconnect', async () => {
    useAgentPermissionStore.getState().setMode('session-1', 'fullAccess');
    render(<AgentPermissionSelector sessionId="session-1" />);
    expect(screen.getByText('agent.permission.fullAccessActive')).toBeVisible();

    useTerminalStore.getState().setClosed('session-1', {
      sessionId: 'session-1',
      reasonKind: 'transport_disconnect',
      retryable: true,
    });

    await waitFor(() => {
      expect(useAgentPermissionStore.getState().getMode('session-1')).toBe('requestApproval');
    });
    expect(screen.queryByText('agent.permission.fullAccessActive')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'agent.permission' })).toBeDisabled();
  });

  it('shows the connection target without the internal session id before approval', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const { container } = render(
      <AgentApprovalCard
        snapshot={approvalSnapshot()}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );

    expect(screen.getByText('operator@server.example.com:22')).toBeVisible();
    expect(screen.queryByText(/session-1/)).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="agent-approval-card"]')).toHaveStyle({
      '--card-spacing': 'calc(var(--spacing) * 2)',
    });
    expect(container.querySelector('[data-slot="card-content"]')).toHaveClass('gap-2');
    expect(screen.getByText('systemctl restart nginx --no-block')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'agent.approval.approve' }));
    expect(await screen.findByText('agent.approval.dialogDescription')).toBeVisible();
    expect(screen.getByRole('alertdialog')).toHaveClass('p-4');
    expect(screen.getAllByText('operator@server.example.com:22')).toHaveLength(2);
    expect(screen.queryByText(/session-1/)).not.toBeInTheDocument();
    expect(screen.getAllByText('systemctl restart nginx --no-block')).toHaveLength(2);

    const approveButtons = screen.getAllByRole('button', { name: 'agent.approval.approve' });
    const dialogApproveButton = approveButtons[approveButtons.length - 1];
    expect(dialogApproveButton).toHaveClass('h-8');
    expect(screen.getByRole('button', { name: 'agent.approval.reject' })).toHaveClass('h-8');
    fireEvent.click(dialogApproveButton);
    expect(onApprove).toHaveBeenCalledWith(approvalSnapshot().approval);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('shows status, exit code, redacted output, stop, and conditional retry actions accessibly', () => {
    const onStop = vi.fn();
    const onRetry = vi.fn();
    const running = { ...approvalSnapshot(), status: 'running' as const, approval: undefined };
    const { rerender } = render(
      <AgentApprovalCard
        snapshot={running}
        targetTitle="Production"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onStop={onStop}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('agent.status.running');
    fireEvent.click(screen.getByRole('button', { name: 'agent.tool.stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);

    rerender(
      <AgentApprovalCard
        snapshot={{
          ...approvalSnapshot(),
          status: 'failed',
          approval: undefined,
          result: {
            requestId: 'request-1',
            callId: 'call-1',
            status: 'failed',
            exitCode: 1,
            output: 'token=[REDACTED]\nservice failed',
          },
        }}
        targetTitle="Production"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        retryAllowed
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(/agent.tool.exitCode/)).toHaveTextContent('1');
    expect(screen.getByText(/token=\[REDACTED\]/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'agent.tool.retryTask' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('allows manual collapsing and automatically collapses after completion', () => {
    const running = { ...approvalSnapshot(), status: 'running' as const, approval: undefined };
    const { container, rerender } = render(
      <AgentApprovalCard
        snapshot={running}
        targetTitle="Production"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    const collapseButton = screen.getByRole('button', { name: 'agent.tool.collapse' });
    expect(collapseButton).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('[data-slot="card-content"]')).toBeVisible();

    fireEvent.click(collapseButton);
    expect(screen.getByRole('button', { name: 'agent.tool.expand' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(container.querySelector('[data-slot="card-content"]')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'agent.tool.expand' }));
    rerender(
      <AgentApprovalCard
        snapshot={{
          ...running,
          status: 'completed',
          result: {
            requestId: 'request-1',
            callId: 'call-1',
            status: 'completed',
            exitCode: 0,
            output: 'service is healthy',
          },
        }}
        targetTitle="Production"
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'agent.tool.expand' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(container.querySelector('[data-slot="card-content"]')).not.toBeInTheDocument();
    expect(screen.getByText('systemctl restart nginx --no-block')).toBeVisible();
  });

  it('keeps unsuccessful terminal results expanded for review', () => {
    const { container } = render(
      <AgentApprovalCard
        snapshot={{
          ...approvalSnapshot(),
          status: 'failed',
          approval: undefined,
          result: {
            requestId: 'request-1',
            callId: 'call-1',
            status: 'failed',
            exitCode: 1,
            output: 'service failed',
          },
        }}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'agent.tool.collapse' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(container.querySelector('[data-slot="card-content"]')).toBeVisible();
    expect(screen.getByText('service failed')).toBeVisible();
  });
});
