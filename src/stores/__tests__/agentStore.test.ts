import { beforeEach, describe, expect, it } from 'vitest';
import { agentToolKey, useAgentStore } from '../agentStore';
import type { AgentToolApprovalSnapshot } from '@/types/agent';
import { useAgentPermissionStore } from '../agentPermissionStore';

const target = {
  kind: 'remote' as const,
  sessionId: 'session-a',
  profileId: 'profile-a',
  host: 'a.example.com',
  port: 22,
  username: 'root',
};

function begin(requestId = 'request-1'): void {
  useAgentStore.getState().beginRun({
    requestId,
    conversationId: `conversation-${requestId}`,
    conversationStartedAt: '2026-08-28T00:00:00.000Z',
    goal: 'Check nginx',
    providerId: 'openai',
    target,
    targetTitle: 'Production A',
    permissionMode: 'requestApproval',
  });
}

function toolSnapshot(
  status: AgentToolApprovalSnapshot['status'] = 'awaitingApproval',
  callId = 'call-1',
): AgentToolApprovalSnapshot {
  return {
    toolCall: {
      requestId: 'request-1',
      callId,
      name: 'run_terminal_command',
      command: 'systemctl status nginx',
      explanation: 'Read the current service status.',
      target,
    },
    permissionMode: 'requestApproval',
    riskAssessment: { risk: 'readOnly', reason: 'readOnlyAllowlist' },
    decision: { requiresApproval: true, reason: 'modeRequiresApproval' },
    status,
    ...(status === 'awaitingApproval' ? {
      approval: { requestId: 'request-1', callId, approvalId: `approval-${callId}` },
    } : {}),
    ...(['completed', 'failed', 'timedOut', 'cancelled', 'rejected'].includes(status) ? {
      result: {
        requestId: 'request-1',
        callId,
        status: status as 'completed' | 'failed' | 'timedOut' | 'cancelled' | 'rejected',
        ...(status === 'completed' ? { exitCode: 0 } : {}),
        output: status === 'completed' ? 'active (running)' : 'not completed',
      },
    } : {}),
  };
}

describe('agentStore M4 lifecycle', () => {
  beforeEach(() => {
    useAgentPermissionStore.getState().resetAll();
    useAgentStore.setState({
      messages: [],
      runs: {},
      tools: {},
      activeRequestId: undefined,
    });
  });

  it('keeps an empty Assistant message valid when it contains a tool card', () => {
    begin();
    useAgentStore.getState().registerTool(toolSnapshot('awaitingApproval'));
    useAgentStore.getState().completeRun('request-1', false);

    const assistant = useAgentStore.getState().messages.find((message) => message.role === 'assistant');
    expect(assistant).toMatchObject({
      content: '',
      status: 'completed',
      toolCallIds: ['call-1'],
    });
    expect(useAgentStore.getState().runs['request-1']).toMatchObject({
      phase: 'incomplete',
      status: 'incomplete',
    });
  });

  it('exposes every product phase from approval through verified completion', () => {
    begin();
    useAgentStore.getState().markStarted('request-1', 8, 120_000);
    useAgentStore.getState().setPhase('request-1', 'preparingCommand');
    useAgentStore.getState().registerTool(toolSnapshot('awaitingApproval'));
    expect(useAgentStore.getState().runs['request-1'].phase).toBe('awaitingApproval');

    useAgentStore.getState().updateTool(toolSnapshot('running'));
    expect(useAgentStore.getState().runs['request-1'].phase).toBe('executing');
    useAgentStore.getState().updateTool(toolSnapshot('completed'));
    expect(useAgentStore.getState().runs['request-1'].phase).toBe('readingResult');
    useAgentStore.getState().setPhase('request-1', 'verifying');
    useAgentStore.getState().appendText('request-1', 'Nginx is active.');
    useAgentStore.getState().completeRun('request-1', false);

    expect(useAgentStore.getState().runs['request-1']).toMatchObject({
      phase: 'completed',
      status: 'completed',
      maxToolSteps: 8,
      toolResultTimeoutMs: 120_000,
    });
  });

  it('derives partial and incomplete outcomes conservatively from real tool results', () => {
    begin();
    useAgentStore.getState().registerTool(toolSnapshot('completed', 'call-1'));
    useAgentStore.getState().registerTool(toolSnapshot('failed', 'call-2'));
    useAgentStore.getState().completeRun('request-1', false);
    expect(useAgentStore.getState().runs['request-1'].status).toBe('partial');

    begin('request-2');
    const second = toolSnapshot('failed', 'call-3');
    useAgentStore.getState().registerTool({
      ...second,
      toolCall: { ...second.toolCall, requestId: 'request-2' },
      result: { ...second.result!, requestId: 'request-2' },
    });
    useAgentStore.getState().completeRun('request-2', false);
    expect(useAgentStore.getState().runs['request-2'].status).toBe('incomplete');
  });

  it('never reports a nonzero exit or step-limited run as fully completed', () => {
    begin();
    const nonzero = toolSnapshot('completed');
    useAgentStore.getState().registerTool({
      ...nonzero,
      result: { ...nonzero.result!, exitCode: 1, output: 'permission denied' },
    });
    useAgentStore.getState().completeRun('request-1', false);
    expect(useAgentStore.getState().runs['request-1'].status).toBe('incomplete');

    begin('request-2');
    const successful = toolSnapshot('completed');
    useAgentStore.getState().registerTool({
      ...successful,
      toolCall: { ...successful.toolCall, requestId: 'request-2' },
      result: { ...successful.result!, requestId: 'request-2' },
    });
    useAgentStore.getState().markStepLimit('request-2');
    useAgentStore.getState().completeRun('request-2', false);
    expect(useAgentStore.getState().runs['request-2']).toMatchObject({
      phase: 'partial',
      status: 'partial',
      stepLimitReached: true,
    });
  });

  it('keeps tool identities isolated and refuses to clear an active run', () => {
    begin();
    useAgentStore.getState().registerTool(toolSnapshot('running'));
    expect(useAgentStore.getState().tools[agentToolKey('request-1', 'call-1')]).toBeDefined();

    useAgentStore.getState().clear();
    expect(useAgentStore.getState().messages).toHaveLength(2);
    useAgentStore.getState().cancelRun('request-1');
    useAgentStore.getState().clear();
    expect(useAgentStore.getState().messages).toEqual([]);
    expect(useAgentStore.getState().tools).toEqual({});
  });

  it('recovers running state as cancelled without replaying approval or full access', () => {
    begin();
    useAgentStore.getState().registerTool(toolSnapshot('awaitingApproval'));
    const current = useAgentStore.getState();
    const persisted = {
      run: {
        ...current.runs['request-1'],
        permissionMode: 'fullAccess' as const,
      },
      messages: current.messages,
      tools: [current.tools[agentToolKey('request-1', 'call-1')]],
    };
    useAgentStore.setState({
      messages: [],
      runs: {},
      tools: {},
      activeRequestId: undefined,
    });

    useAgentStore.getState().hydrateConversation('conversation-request-1', [persisted]);

    const recovered = useAgentStore.getState();
    expect(recovered.activeRequestId).toBeUndefined();
    expect(recovered.runs['request-1']).toMatchObject({
      status: 'cancelled',
      phase: 'incomplete',
      permissionMode: 'fullAccess',
      stopRequested: true,
    });
    expect(recovered.tools[agentToolKey('request-1', 'call-1')]).toMatchObject({
      status: 'cancelled',
      recoveredFromStatus: 'awaitingApproval',
      approval: undefined,
      result: { status: 'cancelled', output: '' },
    });
    expect(recovered.messages.find((message) => message.role === 'assistant')?.status)
      .toBe('cancelled');
    expect(useAgentPermissionStore.getState().getMode('session-a')).toBe('requestApproval');
    expect(useAgentPermissionStore.getState().bindings).toEqual({});
  });

  it('does not let a late callback overwrite a committed tool terminal state', () => {
    begin();
    useAgentStore.getState().registerTool(toolSnapshot('running'));
    useAgentStore.getState().updateTool(toolSnapshot('timedOut'));
    useAgentStore.getState().updateTool(toolSnapshot('completed'));

    expect(useAgentStore.getState().tools[agentToolKey('request-1', 'call-1')])
      .toMatchObject({ status: 'timedOut' });
  });

  it('clears only the selected Agent conversation lane', () => {
    begin('request-1');
    useAgentStore.getState().cancelRun('request-1');
    begin('request-2');
    useAgentStore.getState().cancelRun('request-2');

    useAgentStore.getState().clearConversation('conversation-request-1');

    expect(useAgentStore.getState().runs['request-1']).toBeUndefined();
    expect(useAgentStore.getState().runs['request-2']).toBeDefined();
    expect(useAgentStore.getState().messages.every((message) => (
      message.conversationId === 'conversation-request-2'
    ))).toBe(true);
  });
});
