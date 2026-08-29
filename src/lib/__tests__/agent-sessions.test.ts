import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAgentConversationData,
  hydrateAgentSession,
  persistAgentRunState,
} from '@/lib/agent-sessions';
import { agentToolKey, useAgentStore } from '@/stores/agentStore';
import type { AiSessionFile } from '@/types/ai';

const tauri = vi.hoisted(() => ({
  appendAgentState: vi.fn(async (
    _conversationId: string,
    _startedAt: string,
    _state: unknown,
  ) => {}),
  clearLane: vi.fn(async (
    _conversationId: string,
    _startedAt: string,
    _lane: string,
  ) => {}),
}));

vi.mock('@/lib/tauri', () => ({
  invokeAppendAiSessionAgentState: tauri.appendAgentState,
  invokeClearAiSessionLane: tauri.clearLane,
}));

const target = {
  kind: 'remote' as const,
  sessionId: 'session-agent',
  host: 'example.test',
  port: 22,
  username: 'root',
};

describe('Agent session persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentStore.setState({
      messages: [],
      runs: {},
      tools: {},
      activeRequestId: undefined,
    });
  });

  it('deeply redacts a run snapshot and strips actionable approval ids before IPC', async () => {
    useAgentStore.getState().beginRun({
      requestId: 'request-agent',
      conversationId: 'conversation-agent',
      conversationStartedAt: '2026-08-28T00:00:00.000Z',
      goal: 'Inspect service',
      providerId: 'openai',
      target,
      targetTitle: 'Agent target',
      permissionMode: 'requestApproval',
      rolloutStage: 'preview',
    });
    useAgentStore.getState().registerTool({
      toolCall: {
        requestId: 'request-agent',
        callId: 'call-agent',
        name: 'run_terminal_command',
        command: 'curl --api-key nested-command-secret https://example.test',
        explanation: 'Inspect the endpoint.',
        target,
      },
      permissionMode: 'requestApproval',
      riskAssessment: { risk: 'stateChange', reason: 'unrecognizedStateChange' },
      decision: { requiresApproval: true, reason: 'modeRequiresApproval' },
      status: 'awaitingApproval',
      approval: {
        requestId: 'request-agent',
        callId: 'call-agent',
        approvalId: 'actionable-approval',
      },
    });

    await persistAgentRunState('request-agent');

    expect(tauri.appendAgentState).toHaveBeenCalledTimes(1);
    const persisted = tauri.appendAgentState.mock.calls[0][2];
    const encoded = JSON.stringify(persisted);
    expect(encoded).not.toContain('nested-command-secret');
    expect(encoded).not.toContain('actionable-approval');
    expect(useAgentStore.getState().tools[
      agentToolKey('request-agent', 'call-agent')
    ].toolCall.command).toContain('nested-command-secret');
  });

  it('hydrates interrupted snapshots as cancelled and never creates an active request', () => {
    const session: AiSessionFile = {
      conversation: {
        id: 'conversation-agent',
        startedAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:01:00.000Z',
        title: 'Agent target',
        archived: true,
        host: 'example.test',
        port: 22,
        username: 'root',
      },
      messages: [],
      agentStates: [{
        run: {
          requestId: 'request-agent',
          conversationId: 'conversation-agent',
          conversationStartedAt: '2026-08-28T00:00:00.000Z',
          goal: 'Inspect service',
          providerId: 'openai',
          target,
          targetTitle: 'Agent target',
          permissionMode: 'fullAccess',
          rolloutStage: 'preview',
          toolCallIds: [],
          phase: 'analyzing',
          status: 'running',
          stopRequested: false,
        },
        messages: [],
        tools: [],
      }],
    };

    hydrateAgentSession(session);

    expect(useAgentStore.getState().activeRequestId).toBeUndefined();
    expect(useAgentStore.getState().runs['request-agent']).toMatchObject({
      status: 'cancelled',
      permissionMode: 'fullAccess',
    });
  });

  it('writes an Agent lane tombstone before clearing only that conversation', async () => {
    useAgentStore.getState().beginRun({
      requestId: 'request-agent',
      conversationId: 'conversation-agent',
      conversationStartedAt: '2026-08-28T00:00:00.000Z',
      goal: 'Inspect service',
      providerId: 'openai',
      target,
      targetTitle: 'Agent target',
      permissionMode: 'requestApproval',
    });
    useAgentStore.getState().cancelRun('request-agent');

    await clearAgentConversationData(
      'conversation-agent',
      '2026-08-28T00:00:00.000Z',
    );

    expect(tauri.clearLane).toHaveBeenCalledWith(
      'conversation-agent',
      '2026-08-28T00:00:00.000Z',
      'agent',
    );
    expect(useAgentStore.getState().messages).toEqual([]);
  });
});
