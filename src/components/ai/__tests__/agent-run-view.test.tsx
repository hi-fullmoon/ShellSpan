import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRunView } from '../agent-run-view';
import { initI18n } from '@/locales';
import { useAgentStore } from '@/stores/agentStore';

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
    useAgentStore.setState({
      messages: [],
      runs: {},
      tools: {},
      contextLimitedRequests: {},
      activeRequestId: undefined,
    });
  });

  it('keeps an empty-text tool message visible without the target-binding banner', () => {
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
        onRetry={vi.fn()}
        canRetry={() => false}
        onSwitchToAsk={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByRole('log', { name: 'Agent task conversation' })).toBeInTheDocument();
    expect(screen.queryByTestId('agent-target-binding')).not.toBeInTheDocument();
    expect(screen.getByText('systemctl restart nginx')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalledWith({
      requestId: 'request-1',
      callId: 'call-1',
      approvalId: 'approval-1',
    });
  });

  it('identifies the exact fallback run when continuing in Ask', () => {
    useAgentStore.getState().beginRun({
      requestId: 'request-fallback',
      goal: 'Inspect the old host',
      providerId: 'compatible',
      target,
      targetTitle: 'Production A',
      permissionMode: 'requestApproval',
    });
    useAgentStore.getState().markFallback('request-fallback', {
      task: 'ask',
      automaticExecution: false,
      assistantTextExecution: 'forbidden',
      reason: 'toolCallingUnsupported',
    });
    useAgentStore.getState().appendText('request-fallback', 'Use read-only Ask instead.');
    useAgentStore.getState().finishRun('request-fallback', 'incomplete');
    const onSwitchToAsk = vi.fn();

    render(
      <AgentRunView
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRetry={vi.fn()}
        canRetry={() => false}
        onSwitchToAsk={onSwitchToAsk}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Continue in Ask' }));
    expect(onSwitchToAsk).toHaveBeenCalledWith('request-fallback');
  });

  it('shows when only the Agent model context was shortened', () => {
    useAgentStore.getState().beginRun({
      requestId: 'request-bounded',
      goal: 'Inspect the complete local history',
      providerId: 'openai',
      target,
      targetTitle: 'Production A',
      permissionMode: 'requestApproval',
    });

    render(
      <AgentRunView
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRetry={vi.fn()}
        canRetry={() => false}
        onSwitchToAsk={vi.fn()}
        onOpenSettings={vi.fn()}
        requestBudgetNotices={{
          'request-bounded': {
            omittedTurns: 1,
            omittedMessages: 2,
            truncatedMessages: 0,
            terminalContextTruncated: true,
          },
        }}
      />,
    );

    const notice = screen.getByText(
      'Only the context sent to the model was shortened for this request. Your complete local conversation history is unchanged.',
    );
    expect(notice.closest('[data-slot="marker"]')).toBeInTheDocument();
    expect(screen.getByText('Inspect the complete local history')).toBeVisible();
  });

  it('shows when the backend limits the internal Agent context', () => {
    useAgentStore.getState().beginRun({
      requestId: 'request-backend-bounded',
      goal: 'Inspect the terminal with bounded internal context',
      providerId: 'openai',
      target,
      targetTitle: 'Production A',
      permissionMode: 'requestApproval',
    });
    useAgentStore.getState().markContextLimited('request-backend-bounded');

    render(
      <AgentRunView
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRetry={vi.fn()}
        canRetry={() => false}
        onSwitchToAsk={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    const notice = screen.getByText(
      'Only the context sent to the model was shortened for this request. Your complete local conversation history is unchanged.',
    );
    expect(notice.closest('[data-slot="marker"]')).toBeInTheDocument();
    expect(screen.getByText('Inspect the terminal with bounded internal context')).toBeVisible();
  });

  it('uses the persistent composer stop control instead of flashing a destructive tool-card action', () => {
    useAgentStore.getState().beginRun({
      requestId: 'request-full-access',
      goal: 'Inspect nginx',
      providerId: 'openai',
      target,
      targetTitle: 'Production A',
      permissionMode: 'fullAccess',
    });
    useAgentStore.getState().registerTool({
      toolCall: {
        requestId: 'request-full-access',
        callId: 'call-running',
        name: 'run_terminal_command',
        command: 'systemctl status nginx',
        explanation: 'Inspect nginx on the frozen production target.',
        target,
      },
      permissionMode: 'fullAccess',
      riskAssessment: { risk: 'readOnly', reason: 'readOnlyAllowlist' },
      decision: { requiresApproval: false, reason: 'fullAccess' },
      status: 'running',
    });

    render(
      <AgentRunView
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRetry={vi.fn()}
        canRetry={() => false}
        onSwitchToAsk={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Running');
    expect(screen.queryByRole('button', { name: 'Stop command' })).not.toBeInTheDocument();
  });
});
