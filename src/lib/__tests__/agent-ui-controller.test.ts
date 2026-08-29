import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentUiController } from '../agent-ui-controller';
import { useAgentPermissionStore } from '@/stores/agentPermissionStore';
import { agentToolKey, useAgentStore } from '@/stores/agentStore';
import { useAiSettingsStore } from '@/stores/aiSettingsStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type {
  AgentStreamEvent,
  AgentStartRequest,
  AgentTargetSnapshot,
  AgentToolCall,
  AgentToolResult,
} from '@/types/agent';

const target: AgentTargetSnapshot = {
  kind: 'remote',
  sessionId: 'session-a',
  profileId: 'profile-a',
  host: 'a.example.com',
  port: 22,
  username: 'root',
};

const provider = {
  id: 'openai',
  kind: 'openAi' as const,
  baseUrl: 'https://api.openai.com',
  model: 'gpt-test',
  requiresApiKey: false,
};

function toolCall(command = 'systemctl status nginx', callId = 'call-1'): AgentToolCall {
  return {
    requestId: 'request-1',
    callId,
    name: 'run_terminal_command',
    command,
    explanation: 'Inspect nginx and return real evidence.',
    target,
  };
}

function completed(call: AgentToolCall, output = 'active (running)'): AgentToolResult {
  return {
    requestId: call.requestId,
    callId: call.callId,
    status: 'completed',
    exitCode: 0,
    output,
  };
}

function connectTerminal(): void {
  useTerminalStore.setState({
    sessions: [{
      sessionId: target.sessionId,
      title: 'Production A',
      host: target.host,
      port: target.port,
      username: target.username,
      profileId: target.profileId,
      status: 'connected',
    }],
    activeSessionId: target.sessionId,
  });
}

interface Harness {
  controller: AgentUiController;
  emit: (event: AgentStreamEvent) => void;
  cancelRequest: ReturnType<typeof vi.fn>;
  submitResult: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  startRequest: ReturnType<typeof vi.fn>;
}

function harness(options: {
  mode?: 'requestApproval' | 'autoApproveReadOnly' | 'fullAccess';
  execute?: (call: AgentToolCall) => Promise<AgentToolResult>;
  startRequest?: () => Promise<void>;
  validateTarget?: () => string | null;
  submitResult?: (result: AgentToolResult) => Promise<void>;
  subscribeToTerminalStore?: boolean;
} = {}): Harness {
  let streamListener: ((event: { payload: AgentStreamEvent }) => void) | undefined;
  const cancelRequest = vi.fn(async () => {});
  const submitResult = vi.fn(options.submitResult ?? (async () => {}));
  const execute = vi.fn(async ({ toolCall: call }: { toolCall: AgentToolCall }) => (
    options.execute ? options.execute(call) : completed(call)
  ));
  const startRequest = vi.fn(options.startRequest ?? (async () => {}));
  const validateTarget = options.validateTarget ?? (() => null);
  const controller = new AgentUiController({
    startRequest,
    cancelRequest,
    submitResult,
    validateTarget,
    createRequestId: () => 'request-1',
    runtimeAvailable: () => true,
    listen: async (listener) => {
      streamListener = listener;
      return () => {
        streamListener = undefined;
      };
    },
    approvalDependencies: {
      getPermissionMode: () => options.mode ?? 'requestApproval',
      validateTarget,
      execute,
      cancelExecution: vi.fn(() => false),
    },
    subscribeToTerminalStore: options.subscribeToTerminalStore ?? false,
    subscribeToRegistry: false,
  });
  return {
    controller,
    emit: (event) => {
      if (!streamListener) throw new Error('stream listener not installed');
      streamListener({ payload: event });
    },
    cancelRequest,
    submitResult,
    execute,
    startRequest,
  };
}

async function startRun(h: Harness): Promise<void> {
  await h.controller.connect();
  await h.controller.start({
    goal: 'Check nginx',
    provider,
    target,
    targetTitle: 'Production A',
    messages: [{ role: 'user', content: 'Check nginx' }],
  });
  h.emit({
    type: 'started',
    requestId: 'request-1',
    target,
    maxToolSteps: 8,
    toolResultTimeoutMs: 120_000,
  });
  h.emit({
    type: 'capabilityDetected',
    requestId: 'request-1',
    capability: { support: 'supported', source: 'openAiResponses' },
  });
}

const controllers: AgentUiController[] = [];

describe('AgentUiController M4 integration', () => {
  beforeEach(() => {
    useAgentStore.setState({ messages: [], runs: {}, tools: {}, activeRequestId: undefined });
    useAgentPermissionStore.setState({ bindings: {} });
    useAiSettingsStore.setState({ agentEnabled: true });
    connectTerminal();
  });

  afterEach(() => {
    controllers.splice(0).forEach((controller) => controller.dispose());
  });

  it('installs the listener before start and completes a fully approved tool flow', async () => {
    let emittedDuringStart = false;
    let streamListener: ((event: { payload: AgentStreamEvent }) => void) | undefined;
    const submitResult = vi.fn(async () => {});
    const controller = new AgentUiController({
      startRequest: vi.fn(async (request) => {
        emittedDuringStart = Boolean(streamListener);
        streamListener?.({
          payload: {
            type: 'started',
            requestId: request.request.requestId,
            target,
            maxToolSteps: 8,
            toolResultTimeoutMs: 120_000,
          },
        });
      }),
      cancelRequest: vi.fn(async () => {}),
      submitResult,
      validateTarget: () => null,
      createRequestId: () => 'request-1',
      runtimeAvailable: () => true,
      listen: async (listener) => {
        streamListener = listener;
        return () => {};
      },
      approvalDependencies: {
        getPermissionMode: () => 'requestApproval',
        validateTarget: () => null,
        execute: async ({ toolCall: call }) => completed(call),
      },
      subscribeToTerminalStore: false,
      subscribeToRegistry: false,
    });
    controllers.push(controller);

    await controller.start({
      goal: 'Check nginx',
      provider,
      target,
      targetTitle: 'Production A',
      messages: [{ role: 'user', content: 'Check nginx' }],
    });
    expect(emittedDuringStart).toBe(true);
    const call = toolCall();
    controller.handleStreamEvent({ type: 'toolCall', requestId: 'request-1', step: 1, toolCall: call });
    const awaiting = useAgentStore.getState().tools[agentToolKey('request-1', 'call-1')];
    expect(awaiting.status).toBe('awaitingApproval');
    expect(controller.approve(awaiting.approval!)).toBe(true);

    await vi.waitFor(() => {
      expect(useAgentStore.getState().tools[agentToolKey('request-1', 'call-1')].status)
        .toBe('completed');
    });
    expect(submitResult).toHaveBeenCalledWith(completed(call));
    controller.handleStreamEvent({
      type: 'toolResultAccepted',
      requestId: 'request-1',
      step: 1,
      callId: 'call-1',
      status: 'completed',
    });
    controller.handleStreamEvent({ type: 'textDelta', requestId: 'request-1', turn: 2, text: 'Nginx is active.' });
    controller.handleStreamEvent({ type: 'completed', requestId: 'request-1', toolSteps: 1, fallback: false });
    expect(useAgentStore.getState().runs['request-1'].status).toBe('completed');
  });

  it('refuses to start or retry after the user closes Agent access', async () => {
    const h = harness();
    controllers.push(h.controller);
    useAiSettingsStore.setState({ agentEnabled: false });

    expect(await h.controller.start({
      goal: 'Check nginx',
      provider,
      target,
      targetTitle: 'Production A',
      messages: [{ role: 'user', content: 'Check nginx' }],
    })).toBeUndefined();
    expect(h.startRequest).not.toHaveBeenCalled();
    expect(useAgentStore.getState().activeRequestId).toBeUndefined();

    useAiSettingsStore.setState({ agentEnabled: true });
    await h.controller.start({
      goal: 'Check nginx',
      provider,
      target,
      targetTitle: 'Production A',
      messages: [{ role: 'user', content: 'Check nginx' }],
    });
    h.emit({ type: 'error', requestId: 'request-1', message: 'provider unavailable' });
    useAiSettingsStore.setState({ agentEnabled: false });

    expect(h.controller.canRetry('request-1')).toBe(false);
    expect(await h.controller.retry('request-1', provider)).toBeUndefined();
    expect(h.startRequest).toHaveBeenCalledOnce();
  });

  it('auto-runs only the read-only tool in approve-for-me mode', async () => {
    useAgentPermissionStore.getState().setMode('session-a', 'autoApproveReadOnly');
    const h = harness({ mode: 'autoApproveReadOnly' });
    controllers.push(h.controller);
    await startRun(h);
    h.emit({ type: 'toolCall', requestId: 'request-1', step: 1, toolCall: toolCall() });

    await vi.waitFor(() => expect(h.execute).toHaveBeenCalledTimes(1));
    expect(useAgentStore.getState().tools[agentToolKey('request-1', 'call-1')].decision)
      .toMatchObject({ requiresApproval: false, reason: 'readOnlyAutoApproved' });
    expect(h.submitResult).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('deeply redacts future nested tool-result fields before model submission', async () => {
    const h = harness({
      mode: 'fullAccess',
      execute: async (call) => ({
        ...completed(call, 'safe output'),
        metadata: {
          credentials: { password: 'nested-model-secret' },
          safe: 'kept',
        },
      } as unknown as AgentToolResult),
    });
    controllers.push(h.controller);
    await startRun(h);
    h.emit({ type: 'toolCall', requestId: 'request-1', step: 1, toolCall: toolCall() });

    await vi.waitFor(() => expect(h.submitResult).toHaveBeenCalledTimes(1));
    const submitted = h.submitResult.mock.calls[0][0];
    expect(JSON.stringify(submitted)).not.toContain('nested-model-secret');
    expect(submitted).toMatchObject({
      metadata: { credentials: '[REDACTED]', safe: 'kept' },
    });
  });

  it('rejects a call, submits the rejection once, and stops the backend task', async () => {
    const h = harness();
    controllers.push(h.controller);
    await startRun(h);
    h.emit({ type: 'toolCall', requestId: 'request-1', step: 1, toolCall: toolCall('systemctl restart nginx') });
    const snapshot = useAgentStore.getState().tools[agentToolKey('request-1', 'call-1')];

    expect(h.controller.reject(snapshot.approval!)).toBe(true);
    expect(useAgentStore.getState().tools[agentToolKey('request-1', 'call-1')].status).toBe('rejected');
    expect(useAgentStore.getState().runs['request-1'].status).toBe('incomplete');
    expect(h.submitResult).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
    expect(h.cancelRequest).toHaveBeenCalledWith('request-1');
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('stops both a running PTY call and the backend request', async () => {
    let finish!: (result: AgentToolResult) => void;
    const execution = new Promise<AgentToolResult>((resolve) => {
      finish = resolve;
    });
    const cancelExecution = vi.fn(() => {
      finish({
        requestId: 'request-1',
        callId: 'call-1',
        status: 'cancelled',
        output: 'Command cancelled by the user.',
      });
      return true;
    });
    let streamListener: ((event: { payload: AgentStreamEvent }) => void) | undefined;
    const cancelRequest = vi.fn(async () => {});
    const controller = new AgentUiController({
      startRequest: vi.fn(async () => {}),
      cancelRequest,
      submitResult: vi.fn(async () => {}),
      validateTarget: () => null,
      createRequestId: () => 'request-1',
      runtimeAvailable: () => true,
      listen: async (listener) => {
        streamListener = listener;
        return () => {};
      },
      approvalDependencies: {
        getPermissionMode: () => 'fullAccess',
        validateTarget: () => null,
        execute: () => execution,
        cancelExecution,
      },
      subscribeToTerminalStore: false,
      subscribeToRegistry: false,
    });
    controllers.push(controller);
    await controller.start({
      goal: 'Check nginx', provider, target, targetTitle: 'Production A',
      messages: [{ role: 'user', content: 'Check nginx' }],
    });
    streamListener!({ payload: { type: 'toolCall', requestId: 'request-1', step: 1, toolCall: toolCall() } });
    expect(controller.stop('request-1')).toBe(true);

    expect(cancelExecution).toHaveBeenCalledWith('request-1', 'call-1');
    expect(cancelRequest).toHaveBeenCalledWith('request-1');
    expect(useAgentStore.getState().runs['request-1'].status).toBe('cancelled');
    await vi.waitFor(() => {
      expect(useAgentStore.getState().tools[agentToolKey('request-1', 'call-1')].status)
        .toBe('cancelled');
    });
  });

  it('reissues cancellation when stopped before backend start registration finishes', async () => {
    let finishStart!: () => void;
    const pendingStart = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const h = harness({ startRequest: () => pendingStart });
    controllers.push(h.controller);

    const starting = h.controller.start({
      goal: 'Check nginx', provider, target, targetTitle: 'Production A',
      messages: [{ role: 'user', content: 'Check nginx' }],
    });
    await vi.waitFor(() => {
      expect(useAgentStore.getState().runs['request-1']?.status).toBe('running');
    });

    expect(h.controller.stop('request-1')).toBe(true);
    expect(h.cancelRequest).toHaveBeenCalledTimes(1);

    finishStart();
    await expect(starting).resolves.toBe('request-1');
    expect(h.cancelRequest).toHaveBeenCalledTimes(2);
    expect(useAgentStore.getState().runs['request-1'].status).toBe('cancelled');
  });

  it('cancels on exact target drift and never rebinds retry to a replacement session', async () => {
    let valid = true;
    const h = harness({
      validateTarget: () => valid ? null : 'Frozen terminal target identity no longer matches the live session',
      subscribeToTerminalStore: true,
    });
    controllers.push(h.controller);
    await startRun(h);
    valid = false;
    useTerminalStore.getState().setActiveSession('different-tab');

    await vi.waitFor(() => expect(useAgentStore.getState().runs['request-1'].status).toBe('failed'));
    expect(h.cancelRequest).toHaveBeenCalledWith('request-1');
    expect(h.controller.canRetry('request-1')).toBe(false);
    expect(await h.controller.retry('request-1', provider)).toBeUndefined();
  });

  it('does not cancel or retarget when only the active terminal tab changes', async () => {
    const h = harness({ subscribeToTerminalStore: true });
    controllers.push(h.controller);
    await startRun(h);
    useTerminalStore.setState((state) => ({
      sessions: [...state.sessions, {
        sessionId: 'session-b',
        title: 'Staging B',
        host: 'b.example.com',
        port: 22,
        username: 'deploy',
        status: 'connected',
      }],
      activeSessionId: 'session-b',
    }));

    expect(useAgentStore.getState().runs['request-1']).toMatchObject({
      status: 'running',
      target: { sessionId: 'session-a', host: 'a.example.com' },
    });
    expect(h.cancelRequest).not.toHaveBeenCalled();
  });

  it('keeps safe fallback text tool-free and marks the Agent task incomplete', async () => {
    const h = harness();
    controllers.push(h.controller);
    await startRun(h);
    h.emit({
      type: 'safeFallback',
      requestId: 'request-1',
      fallback: {
        task: 'generateCommand',
        automaticExecution: false,
        assistantTextExecution: 'forbidden',
        reason: 'toolCallingUnsupported',
      },
    });
    h.emit({ type: 'textDelta', requestId: 'request-1', turn: 1, text: '```bash\nsystemctl status nginx\n```' });
    h.emit({ type: 'completed', requestId: 'request-1', toolSteps: 0, fallback: true });

    expect(h.execute).not.toHaveBeenCalled();
    expect(useAgentStore.getState().runs['request-1']).toMatchObject({
      status: 'incomplete',
      fallback: { automaticExecution: false, assistantTextExecution: 'forbidden' },
    });
  });

  it('retries the whole task with a new request id while preserving the exact frozen target', async () => {
    const requestIds = ['request-1', 'request-2'];
    let streamListener: ((event: { payload: AgentStreamEvent }) => void) | undefined;
    const startRequest = vi.fn(async (_request: AgentStartRequest) => {});
    const controller = new AgentUiController({
      startRequest,
      cancelRequest: vi.fn(async () => {}),
      submitResult: vi.fn(async () => {}),
      validateTarget: () => null,
      createRequestId: () => requestIds.shift()!,
      runtimeAvailable: () => true,
      listen: async (listener) => {
        streamListener = listener;
        return () => {};
      },
      approvalDependencies: {
        getPermissionMode: () => 'requestApproval',
        validateTarget: () => null,
        execute: async ({ toolCall: call }) => completed(call),
      },
      subscribeToTerminalStore: false,
      subscribeToRegistry: false,
    });
    controllers.push(controller);
    await controller.start({
      goal: 'Check nginx', provider, target, targetTitle: 'Production A',
      messages: [{ role: 'user', content: 'Check nginx' }],
    });
    streamListener!({ payload: { type: 'error', requestId: 'request-1', message: 'temporary provider error' } });

    expect(await controller.retry('request-1', provider)).toBe('request-2');
    expect(startRequest).toHaveBeenCalledTimes(2);
    expect(startRequest.mock.calls[1]?.[0]).toMatchObject({
      request: {
        requestId: 'request-2',
        target,
      },
      messages: [{ role: 'user', content: 'Check nginx' }],
    });
  });

  it('surfaces tool-result submission failure and cancels instead of pretending the model received it', async () => {
    const h = harness({
      mode: 'fullAccess',
      submitResult: async () => {
        throw new Error('backend result channel closed');
      },
    });
    controllers.push(h.controller);
    await startRun(h);
    h.emit({ type: 'toolCall', requestId: 'request-1', step: 1, toolCall: toolCall() });

    await vi.waitFor(() => expect(useAgentStore.getState().runs['request-1']).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('backend result channel closed'),
    }));
    expect(h.cancelRequest).toHaveBeenCalledWith('request-1');
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps the backend tool-result timeout visible when late PTY cancellation settles', async () => {
    let finish!: (result: AgentToolResult) => void;
    const execution = new Promise<AgentToolResult>((resolve) => {
      finish = resolve;
    });
    const h = harness({
      mode: 'fullAccess',
      execute: () => execution,
      submitResult: async () => {
        throw new Error('tool result is no longer pending');
      },
    });
    controllers.push(h.controller);
    await startRun(h);
    h.emit({ type: 'toolCall', requestId: 'request-1', step: 1, toolCall: toolCall() });
    h.emit({
      type: 'toolResultTimedOut',
      requestId: 'request-1',
      step: 1,
      callId: 'call-1',
    });

    expect(useAgentStore.getState().tools[agentToolKey('request-1', 'call-1')]).toMatchObject({
      status: 'timedOut',
      result: { status: 'timedOut' },
    });
    finish({
      requestId: 'request-1',
      callId: 'call-1',
      status: 'cancelled',
      output: 'Command cancelled after the result channel timed out.',
    });
    await vi.waitFor(() => expect(h.submitResult).toHaveBeenCalled());
    expect(useAgentStore.getState().tools[agentToolKey('request-1', 'call-1')].status)
      .toBe('timedOut');
    expect(useAgentStore.getState().runs['request-1'].status).toBe('running');
  });

  it('never executes a delayed tool call after the user stops a full-access task', async () => {
    const h = harness({ mode: 'fullAccess' });
    controllers.push(h.controller);
    await startRun(h);

    expect(h.controller.stop('request-1')).toBe(true);
    h.emit({
      type: 'toolCall',
      requestId: 'request-1',
      step: 1,
      toolCall: toolCall('systemctl restart nginx'),
    });

    expect(h.execute).not.toHaveBeenCalled();
    expect(useAgentStore.getState().tools[agentToolKey('request-1', 'call-1')]).toBeUndefined();
    expect(useAgentStore.getState().runs['request-1'].status).toBe('cancelled');
  });

  it('never executes a delayed tool call after a terminal completion event', async () => {
    const h = harness({ mode: 'fullAccess' });
    controllers.push(h.controller);
    await startRun(h);
    h.emit({ type: 'textDelta', requestId: 'request-1', turn: 1, text: 'No command needed.' });
    h.emit({ type: 'completed', requestId: 'request-1', toolSteps: 0, fallback: false });

    h.emit({
      type: 'toolCall',
      requestId: 'request-1',
      step: 1,
      toolCall: toolCall('systemctl restart nginx'),
    });

    expect(h.execute).not.toHaveBeenCalled();
    expect(useAgentStore.getState().tools[agentToolKey('request-1', 'call-1')]).toBeUndefined();
    expect(useAgentStore.getState().runs['request-1'].status).toBe('completed');
  });

  it('fails closed on overlapping tool calls instead of authorizing a second command', async () => {
    const execution = new Promise<AgentToolResult>(() => {});
    const h = harness({
      mode: 'fullAccess',
      execute: () => execution,
    });
    controllers.push(h.controller);
    await startRun(h);
    h.emit({ type: 'toolCall', requestId: 'request-1', step: 1, toolCall: toolCall('sleep 30') });
    h.emit({
      type: 'toolCall',
      requestId: 'request-1',
      step: 2,
      toolCall: toolCall('systemctl restart nginx', 'call-2'),
    });

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().tools[agentToolKey('request-1', 'call-2')]).toBeUndefined();
    expect(useAgentStore.getState().runs['request-1']).toMatchObject({
      status: 'failed',
      error: 'Agent provider emitted an overlapping terminal tool call.',
    });
    expect(h.cancelRequest).toHaveBeenCalledWith('request-1');
  });
});
