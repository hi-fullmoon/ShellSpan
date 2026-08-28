import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunView } from '../agent-run-view';
import { initI18n } from '@/locales';
import { useAgentStore } from '@/stores/agentStore';
import { useTerminalStore } from '@/stores/terminalStore';

const target = {
  kind: 'remote' as const,
  sessionId: 'session-a',
  profileId: 'profile-a',
  host: 'a.example.com',
  port: 22,
  username: 'root',
};

describe('AgentRunView', () => {
  beforeEach(async () => {
    await initI18n('en-US');
    useAgentStore.setState({ messages: [], runs: {}, tools: {}, activeRequestId: undefined });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 'session-b',
        title: 'Staging B',
        host: 'b.example.com',
        port: 22,
        username: 'deploy',
        status: 'connected',
      }],
      activeSessionId: 'session-b',
    });
  });

  it('keeps an empty-text tool message visible and announces the frozen target and phase', () => {
    useAgentStore.getState().beginRun({
      requestId: 'request-1',
      goal: 'Restart nginx',
      providerId: 'openai',
      target,
      targetTitle: 'Production A',
      permissionMode: 'requestApproval',
    });
    useAgentStore.getState().registerTool({
      toolCall: {
        requestId: 'request-1',
        callId: 'call-1',
        name: 'run_terminal_command',
        command: 'systemctl restart nginx',
        explanation: 'Restart nginx on the frozen production target.',
        target,
      },
      permissionMode: 'requestApproval',
      riskAssessment: { risk: 'stateChange', reason: 'unrecognizedStateChange' },
      decision: { requiresApproval: true, reason: 'modeRequiresApproval' },
      status: 'awaitingApproval',
      approval: { requestId: 'request-1', callId: 'call-1', approvalId: 'approval-1' },
    });
    const onReject = vi.fn();
    render(
      <AgentRunView
        onApprove={vi.fn()}
        onReject={onReject}
        onStop={vi.fn()}
        onRetry={vi.fn()}
        canRetry={() => false}
        onSwitchToCommand={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByTestId('agent-target-binding')).toHaveTextContent('Task remains on its original terminal');
    expect(screen.getByTestId('agent-target-binding')).toHaveTextContent('Production A');
    expect(screen.getByTestId('agent-target-binding')).toHaveTextContent('root@a.example.com:22 · session-a');
    expect(screen.getByRole('log', { name: 'Agent task conversation' })).toBeInTheDocument();
    expect(screen.getByText('systemctl restart nginx')).toBeVisible();
    expect(screen.getAllByText('Waiting for approval').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalledWith({
      requestId: 'request-1',
      callId: 'call-1',
      approvalId: 'approval-1',
    });
  });
});
