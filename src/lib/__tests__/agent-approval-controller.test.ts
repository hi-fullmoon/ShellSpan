import { describe, expect, it, vi } from 'vitest';
import { AgentApprovalController } from '../agent-approval-controller';
import type { AuthorizedAgentTerminalExecution } from '../agent-terminal-executor';
import { useTerminalStore } from '@/stores/terminalStore';
import type {
  AgentPermissionMode,
  AgentRisk,
  AgentToolCall,
  AgentToolResult,
} from '@/types/agent';

function toolCall(command: string, callId = 'call-1'): AgentToolCall {
  return {
    requestId: 'request-1',
    callId,
    name: 'run_terminal_command',
    command,
    explanation: 'Run the reviewed command.',
    target: {
      kind: 'remote',
      sessionId: 'session-1',
      profileId: 'profile-1',
      host: 'server.example.com',
      port: 22,
      username: 'operator',
    },
  };
}

function result(call: AgentToolCall, status: AgentToolResult['status'] = 'completed'): AgentToolResult {
  return {
    requestId: call.requestId,
    callId: call.callId,
    status,
    ...(status === 'completed' ? { exitCode: 0 } : {}),
    output: status === 'completed' ? 'ok' : '',
  };
}

const commands: Record<AgentRisk, string> = {
  readOnly: 'df -h',
  stateChange: 'systemctl restart nginx',
  destructive: 'rm -rf /tmp/cache',
};

const permissionCases: Array<{
  mode: AgentPermissionMode;
  risk: AgentRisk;
  approval: boolean;
}> = [
  { mode: 'requestApproval', risk: 'readOnly', approval: true },
  { mode: 'requestApproval', risk: 'stateChange', approval: true },
  { mode: 'requestApproval', risk: 'destructive', approval: true },
  { mode: 'autoApproveReadOnly', risk: 'readOnly', approval: false },
  { mode: 'autoApproveReadOnly', risk: 'stateChange', approval: true },
  { mode: 'autoApproveReadOnly', risk: 'destructive', approval: true },
  { mode: 'fullAccess', risk: 'readOnly', approval: false },
  { mode: 'fullAccess', risk: 'stateChange', approval: false },
  { mode: 'fullAccess', risk: 'destructive', approval: false },
];

describe('Agent approval controller permission matrix', () => {
  it.each(permissionCases)('$mode / $risk', async ({ mode, risk, approval }) => {
    const submitResult = vi.fn();
    const execute = vi.fn(async ({ toolCall: call }) => result(call));
    const controller = new AgentApprovalController({
      getPermissionMode: () => mode,
      validateTarget: () => null,
      execute,
      submitResult,
      createApprovalId: () => 'approval-1',
      subscribeToTerminalStore: false,
    });
    const snapshot = controller.registerToolCall(toolCall(commands[risk]));

    expect(snapshot.riskAssessment.risk).toBe(risk);
    expect(snapshot.decision.requiresApproval).toBe(approval);
    if (approval) {
      expect(snapshot.status).toBe('awaitingApproval');
      expect(execute).not.toHaveBeenCalled();
      expect(controller.reject(snapshot.approval!)).toBe(true);
      expect((await controller.waitForResult('request-1', 'call-1'))?.status).toBe('rejected');
    } else {
      expect(snapshot.status).toBe('running');
      expect((await controller.waitForResult('request-1', 'call-1'))?.status).toBe('completed');
      expect(execute).toHaveBeenCalledTimes(1);
    }
    expect(submitResult).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});

describe('Agent approval controller race boundaries', () => {
  it('freezes the reviewed call and lets only the first approve/reject event win', async () => {
    let finishExecution!: (value: AgentToolResult) => void;
    const execution = new Promise<AgentToolResult>((resolve) => {
      finishExecution = resolve;
    });
    const execute = vi.fn((_input: AuthorizedAgentTerminalExecution) => execution);
    const submitResult = vi.fn();
    const validateTarget = vi.fn(() => null);
    const controller = new AgentApprovalController({
      getPermissionMode: () => 'requestApproval',
      validateTarget,
      execute,
      submitResult,
      createApprovalId: () => 'approval-1',
      subscribeToTerminalStore: false,
    });
    const mutableCall = toolCall('systemctl restart nginx');
    const snapshot = controller.registerToolCall(mutableCall);
    (mutableCall as { command: string }).command = 'rm -rf /';
    (mutableCall.target as { sessionId: string }).sessionId = 'session-attacker';

    expect(controller.approve({ ...snapshot.approval!, approvalId: 'stale' })).toBe(false);
    expect(controller.approve(snapshot.approval!)).toBe(true);
    expect(controller.reject(snapshot.approval!)).toBe(false);
    expect(controller.approve(snapshot.approval!)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]?.toolCall).toMatchObject({
      command: 'systemctl restart nginx',
      target: { sessionId: 'session-1', username: 'operator' },
    });
    expect(execute.mock.calls[0]?.[0]?.authorization).toEqual({
      decision: 'authorized',
      source: 'explicitUserAction',
      requestId: 'request-1',
      callId: 'call-1',
      sessionId: 'session-1',
    });
    expect(validateTarget).toHaveBeenCalledWith(snapshot.toolCall.target);

    finishExecution(result(snapshot.toolCall));
    expect((await controller.waitForResult('request-1', 'call-1'))?.status).toBe('completed');
    expect(submitResult).toHaveBeenCalledTimes(1);
    controller.cancel('request-1', 'call-1');
    expect(submitResult).toHaveBeenCalledTimes(1);
  });

  it('cannot approve before registration or after target identity drift', async () => {
    const submitResult = vi.fn();
    const execute = vi.fn();
    let valid = true;
    const controller = new AgentApprovalController({
      getPermissionMode: () => 'requestApproval',
      validateTarget: () => valid ? null : 'Frozen target identity changed before approval.',
      execute,
      submitResult,
      createApprovalId: () => 'approval-1',
      subscribeToTerminalStore: false,
    });
    expect(controller.approve({
      requestId: 'request-1',
      callId: 'call-1',
      approvalId: 'approval-1',
    })).toBe(false);

    const snapshot = controller.registerToolCall(toolCall('systemctl restart nginx'));
    valid = false;
    expect(controller.approve(snapshot.approval!)).toBe(true);
    expect((await controller.waitForResult('request-1', 'call-1'))).toMatchObject({
      status: 'failed',
      output: 'Frozen target identity changed before approval.',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(submitResult).toHaveBeenCalledTimes(1);
  });

  it('invalidates a pending approval when a terminal lifecycle event exposes drift', async () => {
    const originalTerminalState = useTerminalStore.getState();
    const submitResult = vi.fn();
    const execute = vi.fn();
    let valid = true;
    const controller = new AgentApprovalController({
      getPermissionMode: () => 'requestApproval',
      validateTarget: () => valid ? null : 'Frozen connection instance is no longer valid.',
      execute,
      submitResult,
      createApprovalId: () => 'approval-1',
    });
    try {
      const snapshot = controller.registerToolCall(toolCall('systemctl restart nginx'));

      valid = false;
      useTerminalStore.setState({ activeSessionId: 'terminal-lifecycle-event' });

      expect((await controller.waitForResult('request-1', 'call-1'))).toMatchObject({
        status: 'failed',
        output: 'Frozen connection instance is no longer valid.',
      });
      expect(controller.approve(snapshot.approval!)).toBe(false);
      expect(execute).not.toHaveBeenCalled();
      expect(submitResult).toHaveBeenCalledTimes(1);
    } finally {
      controller.dispose();
      useTerminalStore.setState(originalTerminalState, true);
    }
  });

  it('does not let a later permission change auto-run an already frozen approval', () => {
    let mode: AgentPermissionMode = 'requestApproval';
    const execute = vi.fn();
    const controller = new AgentApprovalController({
      getPermissionMode: () => mode,
      validateTarget: () => null,
      execute,
      submitResult: vi.fn(),
      createApprovalId: () => 'approval-1',
      subscribeToTerminalStore: false,
    });
    const snapshot = controller.registerToolCall(toolCall('systemctl status nginx'));
    mode = 'fullAccess';

    expect(controller.getSnapshot('request-1', 'call-1')).toMatchObject({
      permissionMode: 'requestApproval',
      status: 'awaitingApproval',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(controller.reject(snapshot.approval!)).toBe(true);
  });

  it('deduplicates replayed toolCall events and mismatched executor results', async () => {
    const submitResult = vi.fn();
    const execute = vi.fn(async () => ({
      requestId: 'different-request',
      callId: 'different-call',
      status: 'completed' as const,
      output: 'untrusted',
    }));
    const controller = new AgentApprovalController({
      getPermissionMode: () => 'fullAccess',
      validateTarget: () => null,
      execute,
      submitResult,
      subscribeToTerminalStore: false,
    });
    const call = toolCall('systemctl status nginx');
    controller.registerToolCall(call);
    controller.registerToolCall({ ...call, command: 'rm -rf /' });

    expect(await controller.waitForResult('request-1', 'call-1')).toMatchObject({
      requestId: 'request-1',
      callId: 'call-1',
      status: 'failed',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(submitResult).toHaveBeenCalledTimes(1);
  });

  it('keeps confidentiality-sensitive reads behind approval in approve-for-me mode', () => {
    const execute = vi.fn();
    const controller = new AgentApprovalController({
      getPermissionMode: () => 'autoApproveReadOnly',
      validateTarget: () => null,
      execute,
      submitResult: vi.fn(),
      createApprovalId: () => 'approval-sensitive-read',
      subscribeToTerminalStore: false,
    });

    const snapshot = controller.registerToolCall(toolCall('cat .env'));

    expect(snapshot.riskAssessment.risk).toBe('readOnly');
    expect(snapshot.decision).toEqual({
      requiresApproval: true,
      reason: 'riskRequiresApproval',
    });
    expect(snapshot.status).toBe('awaitingApproval');
    expect(execute).not.toHaveBeenCalled();
  });

  it('releases full terminal records after the owning request reaches a terminal state', async () => {
    const controller = new AgentApprovalController({
      getPermissionMode: () => 'fullAccess',
      validateTarget: () => null,
      execute: async ({ toolCall: call }) => result(call),
      submitResult: vi.fn(),
      subscribeToTerminalStore: false,
    });
    controller.registerToolCall(toolCall('systemctl status nginx'));
    await controller.waitForResult('request-1', 'call-1');

    controller.releaseRequest('request-1');

    expect(controller.getSnapshot('request-1', 'call-1')).toBeUndefined();
    expect(controller.waitForResult('request-1', 'call-1')).toBeUndefined();
  });

  it('suppresses late execution events after a terminal request is released', async () => {
    let finishExecution!: (value: AgentToolResult) => void;
    const execution = new Promise<AgentToolResult>((resolve) => {
      finishExecution = resolve;
    });
    const submitResult = vi.fn();
    const listener = vi.fn();
    const controller = new AgentApprovalController({
      getPermissionMode: () => 'fullAccess',
      validateTarget: () => null,
      execute: () => execution,
      submitResult,
      subscribeToTerminalStore: false,
    });
    controller.subscribe(listener);
    const call = toolCall('systemctl status nginx');
    controller.registerToolCall(call);
    const pendingResult = controller.waitForResult('request-1', 'call-1');
    listener.mockClear();

    controller.releaseRequest('request-1');
    finishExecution(result(call));

    await expect(pendingResult).resolves.toMatchObject({ status: 'completed' });
    expect(listener).not.toHaveBeenCalled();
    expect(submitResult).not.toHaveBeenCalled();
  });

  it('keeps M2 single-line validation active under full access', async () => {
    const submitResult = vi.fn();
    const controller = new AgentApprovalController({
      getPermissionMode: () => 'fullAccess',
      validateTarget: () => null,
      submitResult,
      subscribeToTerminalStore: false,
    });
    controller.registerToolCall(toolCall('df -h\nrm -rf /'));

    expect(await controller.waitForResult('request-1', 'call-1')).toMatchObject({
      status: 'failed',
      output: expect.stringContaining('one line'),
    });
    expect(submitResult).toHaveBeenCalledTimes(1);
  });
});
