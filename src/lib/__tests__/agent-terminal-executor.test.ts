import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Event as TauriEvent, EventCallback } from '@tauri-apps/api/event';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AgentTargetSnapshot, AgentToolCall } from '@/types/agent';
import {
  AGENT_TERMINAL_CAPTURE_LIMIT_BYTES,
  AGENT_TERMINAL_COMMAND_LIMIT_CHARS,
  AGENT_TERMINAL_MODEL_OUTPUT_LIMIT_BYTES,
  AgentTerminalBoundaryParser,
  AgentTerminalExecutor,
  buildAgentTerminalWrapper,
  createAgentTerminalBoundary,
  getNonAutomatableCommandReason,
  validateFrozenAgentTarget,
  type AgentTerminalExecutionAuthorization,
} from '../agent-terminal-executor';

const terminalEvents = vi.hoisted(() => {
  const data = new Map<string, EventCallback<string>>();
  const status = new Map<string, EventCallback<{
    sessionId: string;
    status: 'connecting' | 'connected' | 'disconnected' | 'error';
    message?: string;
  }>>();
  const closed = new Map<string, EventCallback<{
    sessionId: string;
    reasonKind: 'local_close' | 'controller_dropped' | 'remote_exit' | 'transport_disconnect' | 'error';
    retryable: boolean;
  }>>();

  const event = <T>(sessionId: string, payload: T): TauriEvent<T> => ({
    event: `test:${sessionId}`,
    id: 1,
    payload,
  });

  return {
    data,
    status,
    closed,
    reset() {
      data.clear();
      status.clear();
      closed.clear();
    },
    emitData(sessionId: string, payload: string) {
      data.get(sessionId)?.(event(sessionId, payload));
    },
    emitClosed(sessionId: string) {
      closed.get(sessionId)?.(event(sessionId, {
        sessionId,
        reasonKind: 'transport_disconnect',
        retryable: true,
      }));
    },
  };
});

vi.mock('@/lib/tauri', () => ({
  invokeGetSessionStatus: vi.fn(async (sessionId: string) => ({
    sessionId,
    status: 'connected',
    message: 'ready',
  })),
  invokeMarkSessionReady: vi.fn().mockResolvedValue(undefined),
  invokeSetSessionOutputPaused: vi.fn().mockResolvedValue(undefined),
  invokeResizeSession: vi.fn().mockResolvedValue(undefined),
  invokeWriteSession: vi.fn().mockResolvedValue(undefined),
  invokeOpenUrl: vi.fn().mockResolvedValue(undefined),
  listenToSshData: vi.fn(async (sessionId: string, callback: EventCallback<string>) => {
    terminalEvents.data.set(sessionId, callback);
    return () => {
      if (terminalEvents.data.get(sessionId) === callback) terminalEvents.data.delete(sessionId);
    };
  }),
  listenToSshStatus: vi.fn(async (sessionId: string, callback: EventCallback<{
    sessionId: string;
    status: 'connecting' | 'connected' | 'disconnected' | 'error';
    message?: string;
  }>) => {
    terminalEvents.status.set(sessionId, callback);
    return () => {
      if (terminalEvents.status.get(sessionId) === callback) terminalEvents.status.delete(sessionId);
    };
  }),
  listenToSshClosed: vi.fn(async (sessionId: string, callback: EventCallback<{
    sessionId: string;
    reasonKind: 'local_close' | 'controller_dropped' | 'remote_exit' | 'transport_disconnect' | 'error';
    retryable: boolean;
  }>) => {
    terminalEvents.closed.set(sessionId, callback);
    return () => {
      if (terminalEvents.closed.get(sessionId) === callback) terminalEvents.closed.delete(sessionId);
    };
  }),
}));

const NONCE = '0123456789abcdef'.repeat(3);
const initialTerminalState = useTerminalStore.getState();

function remoteTarget(sessionId = 'session-1'): AgentTargetSnapshot {
  return {
    kind: 'remote',
    sessionId,
    profileId: 'profile-1',
    host: 'server.example.com',
    port: 22,
    username: 'operator',
  };
}

function toolCall(command: string, target = remoteTarget()): AgentToolCall {
  return {
    requestId: 'request-1',
    callId: 'call-1',
    name: 'run_terminal_command',
    command,
    explanation: 'Run the next verified step.',
    target,
  };
}

function authorization(call = toolCall('pwd')): AgentTerminalExecutionAuthorization {
  return {
    decision: 'authorized',
    source: 'explicitUserAction',
    requestId: call.requestId,
    callId: call.callId,
    sessionId: call.target.sessionId,
  };
}

async function createRemoteController(sessionId = 'session-1') {
  useTerminalStore.getState().addSession({
    sessionId,
    title: sessionId,
    host: 'server.example.com',
    port: 22,
    username: 'operator',
  }, 'profile-1');
  useTerminalStore.getState().setStatus(sessionId, { sessionId, status: 'connected' });
  const controller = terminalRegistry.create(
    sessionId,
    useTerminalStore.getState().setStatus,
    useTerminalStore.getState().setClosed,
    (currentSessionId) => useTerminalStore.getState().sessions.find(
      (session) => session.sessionId === currentSessionId,
    )?.status ?? 'disconnected',
    vi.fn(),
  );
  await vi.waitFor(() => expect(terminalEvents.data.has(sessionId)).toBe(true));
  return controller;
}

describe('Agent M2 terminal boundary parser', () => {
  it('handles split markers and a glued output/end/prompt packet', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const parser = new AgentTerminalBoundaryParser(boundary);
    const start = boundary.beginToken;
    for (const piece of [start.slice(0, 7), start.slice(7, 31), start.slice(31)]) {
      expect(parser.push(piece)).toBeNull();
    }
    const result = parser.push(`\r\nfirst\r\nsecond${boundary.endPrefix}7\u001fnext-prompt`);

    expect(result).toEqual({ exitCode: 7 });
    expect(parser.finishCapture().text).toBe('\r\nfirst\r\nsecond');
  });

  it('ignores terminal echo text until the control-framed high-entropy begin marker', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const parser = new AgentTerminalBoundaryParser(boundary);
    const wrapperEcho = `printf '\\036%s:BEGIN\\037' '${boundary.marker.slice(0, 20)}''${boundary.marker.slice(20)}'`;

    expect(parser.push(`${wrapperEcho}\r\n${boundary.marker}:BEGIN\r\n`)).toBeNull();
    expect(parser.push(`${boundary.beginToken}\r\nreal-output${boundary.endPrefix}0\u001f`)).toEqual({
      exitCode: 0,
    });
    expect(parser.finishCapture().text).toBe('\r\nreal-output');
  });

  it('treats an overlong forged exit token as output and still finds the real boundary', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const parser = new AgentTerminalBoundaryParser(boundary);

    parser.push(`${boundary.beginToken}\nstart${boundary.endPrefix}${'9'.repeat(64)}`);
    expect(parser.push(`\nfinish${boundary.endPrefix}0\u001f`)).toEqual({ exitCode: 0 });
    expect(parser.finishCapture().text).toContain('finish');
  });

  it('keeps capture memory bounded while retaining both ends of oversized output', () => {
    const boundary = createAgentTerminalBoundary(NONCE);
    const parser = new AgentTerminalBoundaryParser(boundary);
    parser.push(boundary.beginToken);
    parser.push(`\nhead-${'x'.repeat(AGENT_TERMINAL_CAPTURE_LIMIT_BYTES + 128)}-tail-你`);
    expect(parser.push(`${boundary.endPrefix}0\u001f`)).toEqual({ exitCode: 0 });

    const captured = parser.finishCapture();
    expect(captured.truncated).toBe(true);
    expect(captured.text).toContain('head-');
    expect(captured.text).toContain('-tail-你');
    expect(captured.text).toContain('2 MiB capture boundary');
    expect(captured.text).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(captured.text).length).toBeLessThanOrEqual(
      AGENT_TERMINAL_CAPTURE_LIMIT_BYTES + 128,
    );
  });
});

describe('Agent M2 command wrapper and local blocking', () => {
  it.each(['posix', 'powershell'] as const)(
    'builds a one-line %s wrapper without echoing the actual framed marker',
    (shell) => {
      const boundary = createAgentTerminalBoundary(NONCE);
      const wrapper = buildAgentTerminalWrapper("printf '%s' \"it's-safe\"", boundary, shell);

      expect(wrapper).not.toMatch(/[\r\n]/);
      expect(wrapper).not.toContain(boundary.beginToken);
      expect(wrapper).not.toContain(boundary.endPrefix);
      expect(wrapper).toContain(boundary.marker.slice(0, Math.floor(boundary.marker.length / 2)));
      expect(wrapper).toContain(boundary.marker.slice(Math.floor(boundary.marker.length / 2)));
      if (shell === 'powershell') {
        expect(wrapper).toContain('[ScriptBlock]::Create(');
        expect(wrapper).toContain('[Environment]::NewLine');
        expect(wrapper).toContain('$global:LASTEXITCODE');
        expect(wrapper).not.toContain('Invoke-Expression');
      }
    },
  );

  it.each([
    'vim /etc/hosts',
    'sudo less /var/log/system.log',
    'ssh nested.example.com',
    'tail -f /var/log/system.log',
    'journalctl --follow -u nginx',
    'docker logs -f app',
    'kubectl logs app --follow=true',
    'watch systemctl status nginx',
    'docker exec -it app sh',
    'podman attach app',
    'kubectl exec --tty --interactive app -- sh',
    'Read-Host "Password"',
    'ping -n example.com',
    'cat',
    'ping example.com',
    "bash -c 'ssh nested.example.com'",
    'echo "$(tail -f /var/log/system.log)"',
    'exit',
  ])('blocks commands that cannot safely auto-complete: %s', (command) => {
    expect(getNonAutomatableCommandReason(command)).not.toBeNull();
  });

  it.each([
    'echo ssh nested.example.com',
    'tail -n 50 /var/log/system.log',
    'journalctl -u nginx -n 50',
    'docker logs --tail 50 app',
    'ping -c 2 example.com',
    'ping -n 2 example.com',
    "python3 -c 'print(1)'",
  ])('allows bounded commands: %s', (command) => {
    expect(getNonAutomatableCommandReason(command)).toBeNull();
  });
});

describe('Agent M2 PTY executor', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    terminalEvents.reset();
    terminalRegistry.disposeAll();
    useTerminalStore.setState(initialTerminalState, true);
    await createRemoteController();
  });

  afterEach(() => {
    vi.useRealTimers();
    terminalRegistry.disposeAll();
    useTerminalStore.setState(initialTerminalState, true);
  });

  it('subscribes before writing and captures a fast ANSI-colored result', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('printf fast');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementationOnce(async (sessionId) => {
      terminalEvents.emitData(
        sessionId,
        `echoed wrapper ${boundary.marker}:BEGIN\r\n${boundary.beginToken}\r\n\u001b[31mfast\u001b[0m\r\n${boundary.endPrefix}0\u001f`,
      );
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const result = await executor.execute({ toolCall: call, authorization: authorization(call) });

    expect(result).toEqual({
      requestId: 'request-1',
      callId: 'call-1',
      status: 'completed',
      exitCode: 0,
      output: 'fast',
    });
    expect(invokeWriteSession).toHaveBeenCalledTimes(1);
    expect(invokeWriteSession).toHaveBeenCalledWith('session-1', expect.stringMatching(/\r$/));
  });

  it('does not write until the underlying PTY output listener is ready', async () => {
    const { invokeWriteSession, listenToSshData } = await import('@/lib/tauri');
    terminalRegistry.disposeAll();
    terminalEvents.reset();
    useTerminalStore.setState(initialTerminalState, true);

    let releaseListener!: () => void;
    const listenerGate = new Promise<void>((resolve) => {
      releaseListener = resolve;
    });
    vi.mocked(listenToSshData).mockImplementationOnce(async (sessionId, callback) => {
      await listenerGate;
      terminalEvents.data.set(sessionId, callback);
      return () => {
        if (terminalEvents.data.get(sessionId) === callback) terminalEvents.data.delete(sessionId);
      };
    });

    useTerminalStore.getState().addSession({
      sessionId: 'session-1',
      title: 'session-1',
      host: 'server.example.com',
      port: 22,
      username: 'operator',
    }, 'profile-1');
    useTerminalStore.getState().setStatus('session-1', { sessionId: 'session-1', status: 'connected' });
    terminalRegistry.create(
      'session-1',
      useTerminalStore.getState().setStatus,
      useTerminalStore.getState().setClosed,
      (sessionId) => useTerminalStore.getState().sessions.find(
        (session) => session.sessionId === sessionId,
      )?.status ?? 'disconnected',
      vi.fn(),
    );

    const call = toolCall('printf ready');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementationOnce(async (sessionId) => {
      terminalEvents.emitData(
        sessionId,
        `${boundary.beginToken}\r\nready${boundary.endPrefix}0\u001f`,
      );
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const pending = executor.execute({ toolCall: call, authorization: authorization(call) });
    await Promise.resolve();
    expect(invokeWriteSession).not.toHaveBeenCalled();

    releaseListener();
    const result = await pending;

    expect(result.status).toBe('completed');
    expect(result.output).toBe('ready');
    expect(invokeWriteSession).toHaveBeenCalledTimes(1);
  });

  it('returns non-zero exit status and redacts output before the model boundary', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('false');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementationOnce(async (sessionId) => {
      terminalEvents.emitData(sessionId, boundary.beginToken.slice(0, 19));
      terminalEvents.emitData(sessionId, `${boundary.beginToken.slice(19)}\r\npassword=hunter2\r\n${boundary.endPrefix.slice(0, 23)}`);
      terminalEvents.emitData(sessionId, `${boundary.endPrefix.slice(23)}23\u001f`);
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const result = await executor.execute({ toolCall: call, authorization: authorization(call) });

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(23);
    expect(result.output).toBe('password=[REDACTED]');
    expect(result.output).not.toContain('hunter2');
  });

  it('caps long output at 2 MiB and trims the redacted model result to 64 KiB', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const controller = terminalRegistry.get('session-1')!;
    vi.spyOn(controller.terminal, 'write').mockImplementation((_data, callback) => callback?.());
    const call = toolCall('generate-long-output');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementationOnce(async (sessionId) => {
      terminalEvents.emitData(sessionId, `${boundary.beginToken}\nhead-${'x'.repeat(AGENT_TERMINAL_CAPTURE_LIMIT_BYTES + 256)}`);
      terminalEvents.emitData(sessionId, `\npassword=long-secret\nlatest-tail-你${boundary.endPrefix}0\u001f`);
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const result = await executor.execute({ toolCall: call, authorization: authorization(call) });

    expect(result.status).toBe('completed');
    expect(result.output).toContain('latest-tail-你');
    expect(result.output).not.toContain('long-secret');
    expect(result.output).not.toContain('\u001b');
    expect(result.output).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(result.output).length).toBeLessThanOrEqual(
      AGENT_TERMINAL_MODEL_OUTPUT_LIMIT_BYTES,
    );
  });

  it('times out and sends Ctrl-C to the same frozen PTY', async () => {
    vi.useFakeTimers();
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('sleep 60');
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const pending = executor.execute({
      toolCall: call,
      authorization: authorization(call),
      timeoutMs: 100,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeWriteSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(result.status).toBe('timedOut');
    expect(result.output).toContain('timed out after 100 ms');
    expect(invokeWriteSession).toHaveBeenLastCalledWith('session-1', '\u0003');
  });

  it('uses the 120 second timeout when no override is supplied', async () => {
    vi.useFakeTimers();
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('sleep 180');
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const pending = executor.execute({ toolCall: call, authorization: authorization(call) });
    await Promise.resolve();
    await Promise.resolve();
    expect(invokeWriteSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(invokeWriteSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.status).toBe('timedOut');
    expect(result.output).toContain('120000 ms');
    expect(invokeWriteSession).toHaveBeenLastCalledWith('session-1', '\u0003');
  });

  it('cancels on user stop and sends Ctrl-C to the same frozen PTY', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('sleep 60');
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const pending = executor.execute({ toolCall: call, authorization: authorization(call) });
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalledTimes(1));
    expect(executor.cancel(call.requestId, call.callId)).toBe(true);
    const result = await pending;

    expect(result.status).toBe('cancelled');
    expect(result.output).toContain('cancelled by the user');
    expect(invokeWriteSession).toHaveBeenLastCalledWith('session-1', '\u0003');
    expect(executor.cancel(call.requestId, call.callId)).toBe(false);
  });

  it('fails cleanly when the frozen session disconnects', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const call = toolCall('sleep 60');
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const pending = executor.execute({ toolCall: call, authorization: authorization(call) });
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalledTimes(1));
    terminalEvents.emitClosed('session-1');
    const result = await pending;

    expect(result.status).toBe('failed');
    expect(result.output).toContain('session closed before command completion');
  });

  it('fails when the bound terminal is closed or rebound instead of drifting to a replacement', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const firstCall = toolCall('sleep 60');
    const firstExecutor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });
    const closing = firstExecutor.execute({
      toolCall: firstCall,
      authorization: authorization(firstCall),
    });
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalledTimes(1));
    terminalRegistry.dispose('session-1');
    expect((await closing).status).toBe('failed');

    await createRemoteController();
    vi.mocked(invokeWriteSession).mockClear();
    const secondCall = toolCall('sleep 60');
    const secondExecutor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });
    const rebinding = secondExecutor.execute({
      toolCall: secondCall,
      authorization: authorization(secondCall),
    });
    await vi.waitFor(() => expect(invokeWriteSession).toHaveBeenCalledTimes(1));
    terminalRegistry.rebindSession('session-1', 'replacement-session');
    expect((await rebinding).status).toBe('failed');
    expect(invokeWriteSession).not.toHaveBeenCalledWith('replacement-session', expect.anything());
  });

  it('continues targeting the frozen session after the active tab changes', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    useTerminalStore.getState().addSession({
      sessionId: 'session-2',
      title: 'other',
      host: 'other.example.com',
      port: 22,
      username: 'other',
    }, 'profile-2');
    useTerminalStore.getState().setActiveSession('session-2');
    const call = toolCall('pwd');
    const boundary = createAgentTerminalBoundary(NONCE);
    vi.mocked(invokeWriteSession).mockImplementationOnce(async (sessionId) => {
      terminalEvents.emitData(sessionId, `${boundary.beginToken}\r\n/srv/app\r\n${boundary.endPrefix}0\u001f`);
    });
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });

    const result = await executor.execute({ toolCall: call, authorization: authorization(call) });

    expect(result.status).toBe('completed');
    expect(invokeWriteSession).toHaveBeenCalledWith('session-1', expect.any(String));
    expect(invokeWriteSession).not.toHaveBeenCalledWith('session-2', expect.any(String));
  });

  it('rejects authorization, target identity, command controls, length, and interactive programs before PTY input', async () => {
    const { invokeWriteSession } = await import('@/lib/tauri');
    const executor = new AgentTerminalExecutor({ nonceFactory: () => NONCE, platform: 'linux' });
    const cases = [
      (() => {
        const call = toolCall('pwd');
        return { toolCall: call, authorization: { ...authorization(call), callId: 'wrong-call' } };
      })(),
      (() => {
        const call = toolCall('pwd', { ...remoteTarget(), host: 'changed.example.com' });
        return { toolCall: call, authorization: authorization(call) };
      })(),
      ...['echo one\necho two', 'echo one\recho two', 'echo one\0echo two',
        'echo one\u001becho two', 'echo one\u2028echo two', 'echo one\u2029echo two']
        .map((command) => {
          const call = toolCall(command);
          return { toolCall: call, authorization: authorization(call) };
        }),
      (() => {
        const call = toolCall('x'.repeat(AGENT_TERMINAL_COMMAND_LIMIT_CHARS + 1));
        return { toolCall: call, authorization: authorization(call) };
      })(),
      (() => {
        const call = toolCall('ssh nested.example.com');
        return { toolCall: call, authorization: authorization(call) };
      })(),
    ];

    for (const input of cases) {
      const result = await executor.execute(input);
      expect(result.status).toBe('failed');
    }
    expect(invokeWriteSession).not.toHaveBeenCalled();
  });

  it('validates the frozen target against the exact controller and profile identity', () => {
    const session = useTerminalStore.getState().sessions[0];
    const controller = terminalRegistry.get('session-1');
    expect(validateFrozenAgentTarget(remoteTarget(), session, controller)).toBeNull();
    expect(validateFrozenAgentTarget(
      { ...remoteTarget(), profileId: 'different-profile' },
      session,
      controller,
    )).toContain('identity');
  });
});
