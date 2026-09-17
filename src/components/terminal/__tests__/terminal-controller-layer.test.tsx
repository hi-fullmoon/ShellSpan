import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup as cleanupReact } from '@testing-library/react';
import {
  createAgentTerminalLeaseDisplayFilter,
  createAgentTerminalLeaseCoordinator,
  TAKEOVER_CONFIRMATION_TIMEOUT_MS,
  TerminalControllerLayer,
} from '../terminal-controller-layer';
import { terminalRegistry } from '../registry/terminal-registry';
import { agentTerminalLeaseState } from '../agent-terminal-lease-state';
import { useTerminalStore } from '@/stores/terminalStore';
import { t } from '@/locales';
import type { Event } from '@tauri-apps/api/event';
import type {
  AgentSessionEvent,
  AgentSessionSnapshot,
  AgentTerminalLeaseEvent,
} from '@/types/agent-session';
import type { TerminalIntegrationStateEvent } from '@/types';
import {
  invokeGetAgentRuntimeSession,
  invokeAgentTerminalLeaseReady,
  invokeGetTerminalBrokerSnapshot,
  invokeInterruptAgentRuntime,
  invokeTakeoverAgentTerminal,
  listenToAgentRuntimeSession,
  listenToAgentTerminalLease,
  listenToTerminalIntegrationState,
} from '@/lib/ipc/tauri';

let leaseListener: ((event: Event<AgentTerminalLeaseEvent>) => void) | undefined;
let sessionListener: ((event: Event<AgentSessionEvent>) => void) | undefined;
let integrationListener: ((event: Event<TerminalIntegrationStateEvent>) => void) | undefined;

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = (globalThis.ResizeObserver ?? RO) as typeof ResizeObserver;

vi.mock('@/lib/ipc/tauri', () => ({
  invokeGetSessionStatus: vi.fn().mockResolvedValue({
    sessionId: 's1',
    status: 'connected',
    message: 'ready',
  }),
  invokeMarkSessionReady: vi.fn().mockResolvedValue(undefined),
  invokeGetTerminalBrokerSnapshot: vi.fn().mockResolvedValue({
    rollout: { enabled: false },
  }),
  invokeSetSessionOutputPaused: vi.fn().mockResolvedValue(undefined),
  invokeWriteSession: vi.fn().mockResolvedValue(undefined),
  invokeResizeSession: vi.fn().mockResolvedValue(undefined),
  listenToSshData: vi.fn().mockResolvedValue(() => {}),
  listenToSshStatus: vi.fn().mockResolvedValue(() => {}),
  listenToSshClosed: vi.fn().mockResolvedValue(() => {}),
  invokeAgentTerminalLeaseReady: vi.fn().mockResolvedValue(true),
  invokeGetAgentRuntimeSession: vi.fn().mockResolvedValue({
    header: { executionSurface: 'direct' },
  }),
  invokeInterruptAgentRuntime: vi.fn().mockResolvedValue(undefined),
  invokeTakeoverAgentTerminal: vi.fn().mockResolvedValue(true),
  listenToAgentRuntimeSession: vi.fn().mockImplementation(async (listener) => {
    sessionListener = listener;
    return () => {
      if (sessionListener === listener) sessionListener = undefined;
    };
  }),
  listenToAgentTerminalLease: vi.fn().mockImplementation(async (listener) => {
    leaseListener = listener;
    return () => {
      if (leaseListener === listener) leaseListener = undefined;
    };
  }),
  listenToTerminalIntegrationState: vi.fn().mockImplementation(async (listener) => {
    integrationListener = listener;
    return () => {
      if (integrationListener === listener) integrationListener = undefined;
    };
  }),
}));

const initialState = useTerminalStore.getState();

function addSession(id: string): void {
  useTerminalStore.getState().addSession({
    sessionId: id,
    title: id,
    host: 'h',
    port: 22,
    username: 'u',
  });
}

function seedController(id = 's1') {
  return terminalRegistry.create(
    id,
    vi.fn(),
    vi.fn(),
    () => 'connected',
    vi.fn(),
  );
}

function leaseEvent(
  operationId: string,
  state: AgentTerminalLeaseEvent['state'] = 'acquired',
  overrides: Partial<AgentTerminalLeaseEvent> = {},
): Event<AgentTerminalLeaseEvent> {
  return {
    payload: {
      sessionId: 's1',
      agentSessionId: 'agent-1',
      taskId: 'task-1',
      operationId,
      acquiredAtUnixMs: 1,
      state,
      ...(state === 'released' ? { reason: 'completed' as const } : {}),
      ...overrides,
    },
  } as Event<AgentTerminalLeaseEvent>;
}

function turnEvent(type: 'turn/start' | 'turn/end', turnId = 'turn-1'): AgentSessionEvent {
  return {
    version: 5,
    sessionId: 'agent-1',
    seq: type === 'turn/start' ? 1 : 2,
    timeUnixMs: 1,
    turnId,
    type,
    ...(type === 'turn/end' ? { data: { reason: 'completed' } } : {}),
  } as AgentSessionEvent;
}

describe('TerminalControllerLayer', () => {
  beforeEach(() => {
    cleanupReact();
    terminalRegistry.disposeAll();
    vi.clearAllMocks();
    vi.mocked(invokeAgentTerminalLeaseReady).mockResolvedValue(true);
    vi.mocked(invokeGetAgentRuntimeSession).mockResolvedValue({
      header: { executionSurface: 'direct' },
    } as AgentSessionSnapshot);
    vi.mocked(invokeInterruptAgentRuntime).mockResolvedValue({} as AgentSessionSnapshot);
    vi.mocked(invokeTakeoverAgentTerminal).mockResolvedValue(true);
    vi.mocked(invokeGetTerminalBrokerSnapshot).mockResolvedValue({
      rollout: { enabled: false },
    } as Awaited<ReturnType<typeof invokeGetTerminalBrokerSnapshot>>);
    vi.mocked(listenToAgentRuntimeSession).mockImplementation(async (listener) => {
      sessionListener = listener;
      return () => {
        if (sessionListener === listener) sessionListener = undefined;
      };
    });
    vi.mocked(listenToAgentTerminalLease).mockImplementation(async (listener) => {
      leaseListener = listener;
      return () => {
        if (leaseListener === listener) leaseListener = undefined;
      };
    });
    vi.mocked(listenToTerminalIntegrationState).mockImplementation(async (listener) => {
      integrationListener = listener;
      return () => {
        if (integrationListener === listener) integrationListener = undefined;
      };
    });
    useTerminalStore.setState({
      ...initialState,
      sessions: [],
      activeSessionId: null,
    }, true);
    agentTerminalLeaseState.clearAll();
  });

  afterEach(() => {
    cleanupReact();
    terminalRegistry.disposeAll();
    agentTerminalLeaseState.clearAll();
  });

  it('creates a controller when a session is added', () => {
    render(<TerminalControllerLayer />);
    expect(terminalRegistry.get('s1')).toBeUndefined();
    act(() => {
      addSession('s1');
    });
    expect(terminalRegistry.get('s1')).toBeDefined();
  });

  it('projects authenticated integration state only onto its matching generation', async () => {
    render(<TerminalControllerLayer />);
    act(() => {
      useTerminalStore.getState().addSession({
        sessionId: 's1',
        terminalSessionId: 'terminal-1',
        terminalGeneration: 2,
        title: 'zsh',
        host: 'local',
        port: 0,
        username: 'user',
      });
    });
    await vi.waitFor(() => expect(integrationListener).toBeDefined());
    act(() => integrationListener?.({
      id: 1,
      event: 'terminal-integration-state',
      payload: {
        sessionId: 's1',
        terminalSessionId: 'terminal-1',
        terminalGeneration: 2,
        state: 'ready',
        promptReady: true,
        shell: 'zsh',
      },
    }));
    expect(useTerminalStore.getState().sessions[0]).toMatchObject({
      integrationState: 'ready',
      promptReady: true,
    });
  });

  it('does not present dedicatedAgentPtyRequired as visible-command ready', async () => {
    vi.mocked(invokeGetTerminalBrokerSnapshot).mockResolvedValue({
      terminalExecuteRollout: { enabled: true },
      remoteBoundTerminalRollout: { enabled: true },
      session: {
        terminalSessionId: 'terminal-ssh',
        terminalGeneration: 1,
        transportKind: 'sshPty',
        integrationState: 'degraded',
        integrationReason: 'dedicatedAgentPtyRequired',
        promptReady: false,
      },
    } as Awaited<ReturnType<typeof invokeGetTerminalBrokerSnapshot>>);
    render(<TerminalControllerLayer />);

    act(() => {
      useTerminalStore.getState().addSession({
        sessionId: 'user-ssh',
        terminalSessionId: 'terminal-ssh',
        terminalGeneration: 1,
        title: 'remote',
        host: 'example.test',
        port: 22,
        username: 'user',
      });
    });

    await vi.waitFor(() => expect(useTerminalStore.getState().sessions[0]).toMatchObject({
      integrationState: 'unavailable',
      integrationReason: 'dedicatedAgentPtyRequired',
      promptReady: false,
    }));
  });

  it('does not create a controller until a placeholder resolves to a real session', () => {
    render(<TerminalControllerLayer />);
    act(() => {
      useTerminalStore.getState().beginConnectionAttempt({
        title: 'Pending', host: 'h', port: 22, username: 'u',
      }, 'attempt-1');
    });
    expect(terminalRegistry.get('attempt-1')).toBeUndefined();

    act(() => {
      useTerminalStore.getState().resolveConnectionAttempt('attempt-1', {
        sessionId: 's1', title: 'Connected', host: 'h', port: 22, username: 'u',
      });
    });

    expect(terminalRegistry.get('attempt-1')).toBeUndefined();
    expect(terminalRegistry.get('s1')).toBeDefined();
  });

  it('disposes the controller when a session is removed', () => {
    render(<TerminalControllerLayer />);
    act(() => {
      addSession('s1');
    });
    expect(terminalRegistry.get('s1')).toBeDefined();
    act(() => {
      useTerminalStore.getState().removeSession('s1');
    });
    expect(terminalRegistry.get('s1')).toBeUndefined();
  });

  it('keeps a rebound controller when reconnect replaces the session id', () => {
    render(<TerminalControllerLayer />);
    act(() => {
      addSession('s1');
    });
    const controller = terminalRegistry.get('s1');
    expect(controller).toBeDefined();

    act(() => {
      terminalRegistry.rebindSession('s1', 's2');
      useTerminalStore.getState().reconnectSession('s1', {
        sessionId: 's2',
        title: 's2',
        host: 'h',
        port: 22,
        username: 'u',
      });
    });

    expect(terminalRegistry.get('s2')).toBe(controller);
    expect(terminalRegistry.get('s1')).toBeUndefined();
  });

  it('writes a disconnected hint into restored sessions', async () => {
    render(<TerminalControllerLayer />);
    act(() => {
      useTerminalStore.getState().addRestoredSessions([
        {
          sessionId: 's1',
          title: 's1',
          host: 'h',
          port: 22,
          username: 'u',
          profileId: 'p1',
        },
      ]);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const controller = terminalRegistry.get('s1');
    expect(controller).toBeDefined();
    const buffer = controller!.terminal.buffer.active;
    const content = Array.from(
      { length: buffer.length },
      (_, index) => buffer.getLine(index)?.translateToString(true) ?? '',
    ).join('\n');
    expect(content).toContain(t('terminal.notice.disconnectedHint'));
  });

  it('does not write a disconnected hint for fresh connecting sessions', () => {
    render(<TerminalControllerLayer />);
    act(() => {
      addSession('s1');
    });
    const controller = terminalRegistry.get('s1');
    expect(controller).toBeDefined();
    const buffer = controller!.terminal.buffer.active;
    const content = Array.from(
      { length: buffer.length },
      (_, index) => buffer.getLine(index)?.translateToString(true) ?? '',
    ).join('\n');
    expect(content).not.toContain('terminal.notice.disconnectedHint');
  });

  it('renders null', () => {
    const { container } = render(<TerminalControllerLayer />);
    expect(container.firstChild).toBeNull();
  });

  it('refreshes app terminal colors when the resolved app theme changes', async () => {
    const refreshTheme = vi.spyOn(terminalRegistry, 'refreshTheme');
    render(<TerminalControllerLayer />);

    document.documentElement.setAttribute('data-theme', 'dark');
    await vi.waitFor(() => expect(refreshTheme).toHaveBeenCalled());
    refreshTheme.mockRestore();
  });

  it('wires the setStatus callback from registry.create to the store', () => {
    const createSpy = vi.spyOn(terminalRegistry, 'create');
    render(<TerminalControllerLayer />);
    act(() => {
      addSession('s1');
    });
    const setStatusArg = createSpy.mock.calls[0][1];
    act(() => {
      setStatusArg('s1', { sessionId: 's1', status: 'connected' });
    });
    expect(useTerminalStore.getState().sessions[0].status).toBe('connected');
    createSpy.mockRestore();
  });

  it('wires the setClosed callback from registry.create to the store', () => {
    const createSpy = vi.spyOn(terminalRegistry, 'create');
    render(<TerminalControllerLayer />);
    act(() => {
      addSession('s1');
    });
    const setClosedArg = createSpy.mock.calls[0][2];
    act(() => {
      setClosedArg('s1', {
        sessionId: 's1',
        reasonKind: 'local_close',
        retryable: false,
      });
    });
    expect(useTerminalStore.getState().sessions[0].closed).toEqual({
      sessionId: 's1',
      reasonKind: 'local_close',
      retryable: false,
    });
    createSpy.mockRestore();
  });

  it('locks input and sends bounded frontend preflight before a PTY write', async () => {
    render(<TerminalControllerLayer />);
    act(() => {
      addSession('s1');
      useTerminalStore.getState().setStatus('s1', {
        sessionId: 's1',
        status: 'connected',
      });
    });
    const controller = terminalRegistry.get('s1')!;
    const release = vi.fn();
    const suppressInput = controller.suppressUserInput.bind(controller);
    vi.spyOn(controller, 'suppressUserInput').mockImplementation((onBlocked) => {
      const unlock = suppressInput(onBlocked);
      return () => { release(); unlock(); };
    });

    await vi.waitFor(() => expect(leaseListener).toBeDefined());
    await act(async () => {
      leaseListener?.({
        payload: {
          sessionId: 's1',
          agentSessionId: 'agent-1',
          taskId: 'task-1',
          operationId: 'operation-1',
          acquiredAtUnixMs: 1,
          state: 'acquired',
        },
      } as Event<AgentTerminalLeaseEvent>);
    });
    await vi.waitFor(() => expect(invokeAgentTerminalLeaseReady).toHaveBeenCalledWith({
      sessionId: 's1',
      agentSessionId: 'agent-1',
      operationId: 'operation-1',
      terminalConnected: true,
      outputListenerReady: true,
      hasPendingUserInput: false,
      hasUnverifiedUserSubmission: false,
      hasCredentialPrompt: false,
    }));

    act(() => {
      leaseListener?.({
        payload: {
          sessionId: 's1',
          agentSessionId: 'agent-1',
          taskId: 'task-1',
          operationId: 'operation-1',
          acquiredAtUnixMs: 1,
          state: 'released',
          reason: 'completed',
        },
      } as Event<AgentTerminalLeaseEvent>);
    });
    expect(release).not.toHaveBeenCalled();
    expect(agentTerminalLeaseState.get('s1')).toMatchObject({ terminalOwned: false });
    await expect(controller.writeUserInput('blocked between commands')).resolves.toBe(false);
    act(() => sessionListener?.({ payload: turnEvent('turn/end') } as Event<AgentSessionEvent>));
    expect(release).toHaveBeenCalledOnce();
    await expect(controller.writeUserInput('accepted after turn')).resolves.toBe(true);
  });

  it('locks the bound terminal from turn start before the first command', async () => {
    const controller = seedController();
    act(() => {
      addSession('s1');
      useTerminalStore.getState().setStatus('s1', { sessionId: 's1', status: 'connected' });
    });
    vi.mocked(invokeGetAgentRuntimeSession).mockResolvedValue({
      header: {
        taskId: 'task-1',
        executionSurface: 'boundTerminal',
        target: { sessionId: 's1' },
      },
    } as AgentSessionSnapshot);
    const coordinator = createAgentTerminalLeaseCoordinator();

    coordinator.handleSession(turnEvent('turn/start'));
    await vi.waitFor(() => expect(agentTerminalLeaseState.get('s1')).toMatchObject({
      terminalOwned: false,
      operationId: 'turn:turn-1',
    }));
    await expect(controller.writeUserInput('blocked before first command')).resolves.toBe(false);

    await coordinator.handle(leaseEvent('operation-1').payload);
    await coordinator.handle(leaseEvent('operation-1', 'released', { reason: 'failed' }).payload);
    await expect(controller.writeUserInput('blocked between commands')).resolves.toBe(false);
    coordinator.handleSession(turnEvent('turn/end'));
    await expect(controller.writeUserInput('accepted after turn')).resolves.toBe(true);
    coordinator.dispose();
  });

  it('keeps the frozen source terminal locked and rejects a lease for another terminal', async () => {
    const sourceController = seedController('source-ssh');
    const agentController = seedController('agent-ssh');
    vi.mocked(invokeGetAgentRuntimeSession).mockResolvedValue({
      header: {
        taskId: 'task-1',
        executionSurface: 'boundTerminal',
        target: { sessionId: 'source-ssh' },
      },
    } as AgentSessionSnapshot);
    const coordinator = createAgentTerminalLeaseCoordinator();

    coordinator.handleSession(turnEvent('turn/start'));
    await vi.waitFor(() => expect(agentTerminalLeaseState.get('source-ssh')).toMatchObject({
      terminalOwned: false,
      operationId: 'turn:turn-1',
    }));
    await expect(sourceController.writeUserInput('blocked before Agent PTY')).resolves.toBe(false);

    await coordinator.handle(leaseEvent('operation-1', 'acquired', {
      sessionId: 'agent-ssh',
    }).payload);
    expect(agentTerminalLeaseState.get('source-ssh')).toMatchObject({
      terminalOwned: false,
      operationId: 'turn:turn-1',
    });
    expect(agentTerminalLeaseState.get('agent-ssh')).toBeUndefined();
    await expect(sourceController.writeUserInput('still blocked on frozen source')).resolves.toBe(false);
    await expect(agentController.writeUserInput('never locked on rejected target')).resolves.toBe(true);
    expect(invokeAgentTerminalLeaseReady).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'agent-ssh',
      operationId: 'operation-1',
      terminalConnected: false,
      outputListenerReady: false,
    }));

    coordinator.handleSession(turnEvent('turn/end'));
    expect(agentTerminalLeaseState.get('source-ssh')).toBeUndefined();
    expect(agentTerminalLeaseState.get('agent-ssh')).toBeUndefined();
    await expect(sourceController.writeUserInput('accepted after turn')).resolves.toBe(true);
    coordinator.dispose();
  });

  it('restores input immediately after takeover and fences late Agent leases', async () => {
    vi.mocked(invokeInterruptAgentRuntime).mockReturnValue(new Promise<AgentSessionSnapshot>(() => {}));
    const controller = seedController();
    act(() => {
      addSession('s1');
      useTerminalStore.getState().setStatus('s1', {
        sessionId: 's1',
        status: 'connected',
      });
    });
    const release = vi.fn();
    vi.spyOn(controller, 'suppressUserInput').mockReturnValue(release);
    const coordinator = createAgentTerminalLeaseCoordinator();

    await coordinator.handle(leaseEvent('operation-1').payload);
    act(() => {
      agentTerminalLeaseState.get('s1')?.requestTakeover();
      agentTerminalLeaseState.get('s1')?.requestTakeover();
    });
    await vi.waitFor(() => expect(invokeInterruptAgentRuntime).toHaveBeenCalledOnce());
    expect(invokeTakeoverAgentTerminal).toHaveBeenCalledOnce();
    expect(invokeTakeoverAgentTerminal).toHaveBeenCalledWith({
      sessionId: 's1',
      agentSessionId: 'agent-1',
      operationId: 'operation-1',
    });
    expect(invokeInterruptAgentRuntime).toHaveBeenCalledWith({ sessionId: 'agent-1' });
    expect(release).toHaveBeenCalledOnce();
    expect(agentTerminalLeaseState.get('s1')).toBeUndefined();

    await coordinator.handle(leaseEvent('operation-late').payload);
    expect(invokeAgentTerminalLeaseReady).toHaveBeenLastCalledWith(expect.objectContaining({
      operationId: 'operation-late',
      terminalConnected: false,
      outputListenerReady: false,
    }));
    expect(release).toHaveBeenCalledOnce();
    expect(agentTerminalLeaseState.get('s1')).toBeUndefined();
    coordinator.dispose();
  });

  it('allows turn cancellation to be retried after a rejected request', async () => {
    vi.mocked(invokeTakeoverAgentTerminal).mockResolvedValue(false);
    vi.mocked(invokeInterruptAgentRuntime)
      .mockRejectedValueOnce(new Error('cancel rejected'))
      .mockResolvedValueOnce({} as AgentSessionSnapshot);
    const controller = seedController();
    const release = vi.fn();
    vi.spyOn(controller, 'suppressUserInput').mockReturnValue(release);
    const coordinator = createAgentTerminalLeaseCoordinator();

    await coordinator.handle(leaseEvent('operation-1').payload);
    act(() => agentTerminalLeaseState.get('s1')?.requestTakeover());
    await vi.waitFor(() => {
      expect(agentTerminalLeaseState.get('s1')).toMatchObject({
        takeoverRequested: false,
        takeoverFailed: true,
      });
    });

    act(() => agentTerminalLeaseState.get('s1')?.requestTakeover());
    await vi.waitFor(() => expect(invokeInterruptAgentRuntime).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(agentTerminalLeaseState.get('s1')).toBeUndefined();
    coordinator.dispose();
  });

  it('recovers from an unconfirmed turn cancellation and ignores its late response', async () => {
    vi.useFakeTimers();
    vi.mocked(invokeTakeoverAgentTerminal).mockResolvedValue(false);
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    vi.mocked(invokeInterruptAgentRuntime)
      .mockReturnValueOnce(new Promise<AgentSessionSnapshot>((resolve) => {
        resolveFirst = () => resolve({} as AgentSessionSnapshot);
      }))
      .mockReturnValueOnce(new Promise<AgentSessionSnapshot>((resolve) => {
        resolveSecond = () => resolve({} as AgentSessionSnapshot);
      }));
    const controller = seedController();
    const release = vi.fn();
    vi.spyOn(controller, 'suppressUserInput').mockReturnValue(release);
    const coordinator = createAgentTerminalLeaseCoordinator();

    try {
      await coordinator.handle(leaseEvent('operation-1').payload);
      act(() => agentTerminalLeaseState.get('s1')?.requestTakeover());
      await act(async () => vi.advanceTimersByTimeAsync(TAKEOVER_CONFIRMATION_TIMEOUT_MS));
      expect(agentTerminalLeaseState.get('s1')).toMatchObject({
        takeoverRequested: false,
        takeoverFailed: true,
      });

      act(() => agentTerminalLeaseState.get('s1')?.requestTakeover());
      resolveFirst();
      await act(async () => Promise.resolve());
      expect(agentTerminalLeaseState.get('s1')?.takeoverRequested).toBe(true);
      expect(release).not.toHaveBeenCalled();

      resolveSecond();
      await act(async () => Promise.resolve());
      expect(invokeInterruptAgentRuntime).toHaveBeenCalledTimes(2);
      expect(release).toHaveBeenCalledOnce();
      expect(agentTerminalLeaseState.get('s1')).toBeUndefined();
    } finally {
      coordinator.dispose();
      vi.useRealTimers();
    }
  });

  it('replaces resources by operation and ignores duplicate acquire and stale release events', async () => {
    const controller = seedController();
    vi.mocked(invokeGetAgentRuntimeSession).mockResolvedValue({
      header: {
        taskId: 'task-1',
        executionSurface: 'boundTerminal',
        target: { sessionId: 's1' },
      },
    } as AgentSessionSnapshot);
    act(() => {
      addSession('s1');
      useTerminalStore.getState().setStatus('s1', {
        sessionId: 's1',
        status: 'connected',
      });
    });
    const releaseFirst = vi.fn();
    const removeFirstFilter = vi.fn();
    const removeSecondFilter = vi.fn();
    const suppress = vi.spyOn(controller, 'suppressUserInput').mockReturnValue(releaseFirst);
    const subscribeFilter = vi.spyOn(controller, 'subscribeOutputFilter')
      .mockReturnValueOnce(removeFirstFilter)
      .mockReturnValueOnce(removeSecondFilter);
    const coordinator = createAgentTerminalLeaseCoordinator();

    coordinator.handleSession(turnEvent('turn/start'));
    await coordinator.handle(leaseEvent('operation-1').payload);
    await coordinator.handle(leaseEvent('operation-1').payload);
    expect(suppress).toHaveBeenCalledOnce();
    expect(subscribeFilter).toHaveBeenCalledOnce();
    expect(subscribeFilter.mock.calls[0][0]).toMatchObject({ operationId: 'operation-1' });

    await coordinator.handle(leaseEvent('operation-2', 'acquired', {
      commandDisplay: '[Agent] $ safe command',
    }).payload);
    expect(releaseFirst).not.toHaveBeenCalled();
    expect(removeFirstFilter).toHaveBeenCalledOnce();
    expect(agentTerminalLeaseState.get('s1')).toMatchObject({
      operationId: 'operation-2',
      commandDisplay: '[Agent] $ safe command',
    });

    await coordinator.handle(leaseEvent('operation-1', 'released').payload);
    expect(releaseFirst).not.toHaveBeenCalled();
    expect(agentTerminalLeaseState.get('s1')?.operationId).toBe('operation-2');

    await coordinator.handle(leaseEvent('operation-2', 'released').payload);
    expect(releaseFirst).not.toHaveBeenCalled();
    expect(removeSecondFilter).toHaveBeenCalledOnce();
    expect(agentTerminalLeaseState.get('s1')).toMatchObject({
      operationId: 'operation-2',
      terminalOwned: false,
      inputBlocked: false,
    });
    coordinator.handleSession(turnEvent('turn/end'));
    expect(releaseFirst).toHaveBeenCalledOnce();
    expect(agentTerminalLeaseState.get('s1')).toBeUndefined();
    coordinator.dispose();
  });

  it('reports every bounded ready preflight guard', async () => {
    const controller = seedController();
    act(() => {
      addSession('s1');
      useTerminalStore.getState().setStatus('s1', {
        sessionId: 's1',
        status: 'connected',
      });
    });
    vi.spyOn(controller, 'hasPendingUserInput').mockReturnValue(true);
    vi.spyOn(controller, 'hasUnverifiedUserSubmission').mockReturnValue(true);
    vi.spyOn(controller, 'hasKnownCredentialPrompt').mockReturnValue(true);
    const coordinator = createAgentTerminalLeaseCoordinator();

    await coordinator.handle(leaseEvent('operation-guarded').payload);
    await vi.waitFor(() => expect(invokeAgentTerminalLeaseReady).toHaveBeenCalledWith({
      sessionId: 's1',
      agentSessionId: 'agent-1',
      operationId: 'operation-guarded',
      terminalConnected: true,
      outputListenerReady: true,
      hasPendingUserInput: true,
      hasUnverifiedUserSubmission: true,
      hasCredentialPrompt: true,
    }));
    coordinator.dispose();
  });

  it('rejects readiness when the terminal controller and output listener are unavailable', async () => {
    const coordinator = createAgentTerminalLeaseCoordinator();
    await coordinator.handle(leaseEvent('operation-missing', 'acquired', {
      sessionId: 'missing-terminal',
    }).payload);

    expect(invokeAgentTerminalLeaseReady).toHaveBeenCalledWith({
      sessionId: 'missing-terminal',
      agentSessionId: 'agent-1',
      operationId: 'operation-missing',
      terminalConnected: false,
      outputListenerReady: false,
      hasPendingUserInput: false,
      hasUnverifiedUserSubmission: false,
      hasCredentialPrompt: false,
    });
    coordinator.dispose();
  });

  it('does not acknowledge an operation after it is superseded while listeners initialize', async () => {
    const controller = seedController();
    act(() => {
      addSession('s1');
      useTerminalStore.getState().setStatus('s1', {
        sessionId: 's1',
        status: 'connected',
      });
    });
    let resolveReady!: () => void;
    vi.spyOn(controller, 'whenOutputReady').mockReturnValue(new Promise<void>((resolve) => {
      resolveReady = resolve;
    }));
    const coordinator = createAgentTerminalLeaseCoordinator();

    const first = coordinator.handle(leaseEvent('operation-1').payload);
    const second = coordinator.handle(leaseEvent('operation-2').payload);
    await act(async () => resolveReady());
    await Promise.all([first, second]);

    expect(invokeAgentTerminalLeaseReady).not.toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'operation-1' }),
    );
    expect(invokeAgentTerminalLeaseReady).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'operation-2' }),
    );
    coordinator.dispose();
  });

  it.each(['rebound', 'disposed'] as const)(
    'cleans operation resources when the controller is %s',
    async (lifecycle) => {
      const controller = seedController();
      act(() => {
        addSession('s1');
        useTerminalStore.getState().setStatus('s1', {
          sessionId: 's1',
          status: 'connected',
        });
      });
      const release = vi.fn();
      const removeFilter = vi.fn();
      vi.spyOn(controller, 'suppressUserInput').mockReturnValue(release);
      vi.spyOn(controller, 'subscribeOutputFilter').mockReturnValue(removeFilter);
      const coordinator = createAgentTerminalLeaseCoordinator();

      await coordinator.handle(leaseEvent(`operation-${lifecycle}`).payload);
      act(() => {
        if (lifecycle === 'rebound') terminalRegistry.rebindSession('s1', 's2');
        else terminalRegistry.dispose('s1');
      });

      expect(release).toHaveBeenCalledOnce();
      expect(removeFilter).toHaveBeenCalledOnce();
      expect(agentTerminalLeaseState.get('s1')).toBeUndefined();
      coordinator.dispose();
    },
  );

  it('clears a retained between-command lock when its terminal closes', async () => {
    seedController();
    const coordinator = createAgentTerminalLeaseCoordinator();
    await coordinator.handle(leaseEvent('operation-1').payload);
    await coordinator.handle(leaseEvent('operation-1', 'released').payload);
    expect(agentTerminalLeaseState.get('s1')?.terminalOwned).toBe(false);

    act(() => terminalRegistry.dispose('s1'));
    expect(agentTerminalLeaseState.get('s1')).toBeUndefined();
    coordinator.dispose();
  });

  it('cleans a lease when its terminal is removed and does not carry it into a rebuild', async () => {
    seedController();
    act(() => {
      addSession('s1');
      useTerminalStore.getState().setStatus('s1', {
        sessionId: 's1',
        status: 'connected',
      });
    });
    const coordinator = createAgentTerminalLeaseCoordinator();
    await coordinator.handle(leaseEvent('operation-removed').payload);

    act(() => terminalRegistry.dispose('s1'));
    expect(agentTerminalLeaseState.get('s1')).toBeUndefined();

    seedController();
    expect(terminalRegistry.get('s1')).toBeDefined();
    expect(agentTerminalLeaseState.get('s1')).toBeUndefined();
    coordinator.dispose();
  });

  it('keeps direct terminals free of lease UI state and filters', () => {
    const controller = seedController();
    render(<TerminalControllerLayer />);
    act(() => addSession('s1'));
    const suppress = vi.spyOn(controller, 'suppressUserInput');
    const subscribeFilter = vi.spyOn(controller, 'subscribeOutputFilter');

    expect(agentTerminalLeaseState.get('s1')).toBeUndefined();
    expect(suppress).not.toHaveBeenCalled();
    expect(subscribeFilter).not.toHaveBeenCalled();
  });

  it('uses an operation-identified transparent filter for the backend display stream', () => {
    const filter = createAgentTerminalLeaseDisplayFilter('operation-safe-display');
    expect(filter.operationId).toBe('operation-safe-display');
    expect(filter.push('[Agent] $ redacted\r\noutput')).toBe('[Agent] $ redacted\r\noutput');
    expect(filter.finish()).toBe('');
    expect(filter.push('stale')).toBe('');
  });
});
