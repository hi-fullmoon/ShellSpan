import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  invokeAgentV3AuthorizeCall,
  invokeAgentV3ExecuteTool,
  invokeAgentV3GetTask,
  invokeAgentV3CompactContext,
  invokeAgentV3RefreshContext,
  invokeAgentV3RefreshExtensions,
  invokeAgentV3AuthorizeMcpCall,
  invokeAgentV3ExecuteMcpCall,
  invokeAgentV3ListTasks,
  invokeAgentV3PreviewCall,
  invokeAgentV3RegisterTask,
  invokeAgentV3RestoreCheckpoint,
} from '@/lib/tauri';
import type { AgentLocalTargetV3, AgentRequestV3, AgentToolCallV3 } from '@/types/agent-v3';

const target: AgentLocalTargetV3 = {
  kind: 'local',
  targetId: 'local-1',
  sessionId: 'session-1',
};

const request: AgentRequestV3 = {
  contractVersion: 3,
  requestId: 'req-1',
  userSessionId: 'user-1',
  taskId: 'task-1',
  goal: 'Inspect the local target',
  successCriteria: ['Return structured evidence'],
  targets: [target],
  permissionMode: 'requestApproval',
  sourceContract: 'v3',
};

beforeEach(() => invokeMock.mockReset());

describe('Agent v3 native runtime IPC', () => {
  it('registers and rehydrates a Rust-owned task without sending capability claims', async () => {
    invokeMock
      .mockResolvedValueOnce({ request })
      .mockResolvedValueOnce({ request })
      .mockResolvedValueOnce([{ request }]);

    await invokeAgentV3RegisterTask(request);
    await invokeAgentV3GetTask(request.taskId);
    await invokeAgentV3ListTasks();

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'agent_v3_register_task', { request });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'agent_v3_get_task', {
      taskId: request.taskId,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, 'agent_v3_list_tasks', undefined);
  });

  it('requests an opaque native grant then submits only its capability id with the call', async () => {
    const authorization = {
      taskId: request.taskId,
      requestId: request.requestId,
      callId: 'call-1',
      toolName: 'exec_command' as const,
      arguments: {
        command: 'pwd',
        explanation: 'Inspect the current directory.',
        channel: 'direct' as const,
      },
      target,
    };
    invokeMock.mockResolvedValueOnce({
      capabilityId: 'cap-native',
      expiresAtUnixMs: 100,
      assessedEffect: { kind: 'readOnly', targetId: target.targetId, summary: 'native' },
    });
    const grant = await invokeAgentV3AuthorizeCall(authorization);
    const call: AgentToolCallV3 = {
      requestId: request.requestId,
      callId: authorization.callId,
      toolName: authorization.toolName,
      arguments: authorization.arguments,
      target,
      capabilityId: grant.capabilityId,
    };
    invokeMock.mockResolvedValueOnce({ status: 'completed' });
    await invokeAgentV3ExecuteTool(request.taskId, call);

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'agent_v3_authorize_call', {
      request: authorization,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'agent_v3_execute_tool', {
      taskId: request.taskId,
      call,
    });
    expect(invokeMock.mock.calls.flat().join(' ')).not.toContain('allowedTools');
    expect(invokeMock.mock.calls.flat().join(' ')).not.toContain('allowedEffects');
  });

  it('previews exact diffs and restores checkpoints through dedicated native commands', async () => {
    const authorization = {
      taskId: request.taskId,
      requestId: request.requestId,
      callId: 'call-patch',
      toolName: 'apply_patch' as const,
      arguments: {
        patch: '--- original\n+++ modified\n@@ -1 +1 @@\n-before\n+after\n',
        preconditions: [{ path: 'config.txt', sha256: 'a'.repeat(64) }],
      },
      target,
    };
    invokeMock
      .mockResolvedValueOnce({ toolName: 'apply_patch', path: 'config.txt', diff: authorization.arguments.patch })
      .mockResolvedValueOnce({ checkpointId: 'checkpoint-1', restoredAtUnixMs: 200 });

    await invokeAgentV3PreviewCall(authorization);
    await invokeAgentV3RestoreCheckpoint(request.taskId, 'checkpoint-1');

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'agent_v3_preview_call', { request: authorization });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'agent_v3_restore_checkpoint', {
      taskId: request.taskId,
      checkpointId: 'checkpoint-1',
    });
  });

  it('uses dedicated M3 context commands and keeps MCP execution bound to an opaque grant', async () => {
    invokeMock
      .mockResolvedValueOnce({ generation: 2 })
      .mockResolvedValueOnce({ generation: 3 })
      .mockResolvedValueOnce({ generation: 2 })
      .mockResolvedValueOnce({
        capabilityId: 'cap-mcp-native',
        expiresAtUnixMs: 200,
        assessedEffect: 'externalSideEffect',
        effectiveArguments: { value: 'safe' },
        hookDecisions: [],
      })
      .mockResolvedValueOnce({ status: 'completed' });

    await invokeAgentV3RefreshContext(request.taskId);
    await invokeAgentV3CompactContext(request.taskId, 'manual');
    await invokeAgentV3RefreshExtensions(request.taskId);
    const authorization = {
      taskId: request.taskId,
      requestId: request.requestId,
      callId: 'mcp-call-1',
      serverId: 'fixture',
      toolName: 'write_status',
      arguments: { value: 'safe' },
      targetId: target.targetId,
    };
    const grant = await invokeAgentV3AuthorizeMcpCall(authorization);
    await invokeAgentV3ExecuteMcpCall(request.taskId, {
      requestId: authorization.requestId,
      callId: authorization.callId,
      serverId: authorization.serverId,
      toolName: authorization.toolName,
      arguments: grant.effectiveArguments,
      targetId: authorization.targetId,
      capabilityId: grant.capabilityId,
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'agent_v3_refresh_context', {
      taskId: request.taskId,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'agent_v3_compact_context', {
      taskId: request.taskId,
      reason: 'manual',
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'agent_v3_authorize_mcp_call', {
      request: authorization,
    });
    expect(JSON.stringify(invokeMock.mock.calls)).not.toContain('allowedTools');
    expect(JSON.stringify(invokeMock.mock.calls)).not.toContain('credentialRefs');
  });
});
