import { beforeEach, describe, expect, it } from 'vitest';
import { agentToolKey, useAgentStore } from '../agentStore';
import type { AgentToolApprovalSnapshot } from '@/types/agent';

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
});
