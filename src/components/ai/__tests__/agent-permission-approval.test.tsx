import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApprovalCard } from '../agent-approval-card';
import { AgentPermissionSelector } from '../agent-permission-selector';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AgentToolApprovalSnapshot } from '@/types/agent';

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
    permissionMode: 'autoApproveReadOnly',
    riskAssessment: { risk: 'stateChange', reason: 'unrecognizedStateChange' },
    decision: { requiresApproval: true, reason: 'riskRequiresApproval' },
    status: 'awaitingApproval',
    approval: {
      requestId: 'request-1',
      callId: 'call-1',
      approvalId: 'approval-1',
    },
  };
}

describe('M3 permission and approval components', () => {
  beforeEach(() => {
    useTerminalStore.setState(initialTerminalState, true);
    useAgentPermissionStore.setState(initialPermissionState, true);
    connectSession();
  });

  it('selects safer modes directly and confirms full access with a persistent warning', async () => {
    render(<AgentPermissionSelector sessionId="session-1" />);

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

    fireEvent.click(screen.getByRole('button', {
      name: 'agent.permission.fullAccessConfirm',
    }));
    expect(useAgentPermissionStore.getState().getMode('session-1')).toBe('fullAccess');
    expect(await screen.findByText('agent.permission.fullAccessActive')).toBeVisible();
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

  it('shows the complete target and command before approving or rejecting', async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <AgentApprovalCard
        snapshot={approvalSnapshot()}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );

    expect(screen.getByText('operator@server.example.com:22 · session-1')).toBeVisible();
    expect(screen.getByText('systemctl restart nginx --no-block')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'agent.approval.approve' }));
    expect(await screen.findByText('agent.approval.dialogDescription')).toBeVisible();
    expect(screen.getAllByText('operator@server.example.com:22 · session-1')).toHaveLength(2);
    expect(screen.getAllByText('systemctl restart nginx --no-block')).toHaveLength(2);

    const approveButtons = screen.getAllByRole('button', { name: 'agent.approval.approve' });
    fireEvent.click(approveButtons[approveButtons.length - 1]);
    expect(onApprove).toHaveBeenCalledWith(approvalSnapshot().approval);
    expect(onReject).not.toHaveBeenCalled();
  });
});
