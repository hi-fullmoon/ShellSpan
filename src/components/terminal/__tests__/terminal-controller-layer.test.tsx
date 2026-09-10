import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup as cleanupReact } from '@testing-library/react';
import {
  createAgentTerminalLeaseDisplayFilter,
  createAgentTerminalLeaseCoordinator,
  TerminalControllerLayer,
} from '../terminal-controller-layer';
import { terminalRegistry } from '../registry/terminal-registry';
import { agentTerminalLeaseState } from '../agent-terminal-lease-state';
import { useTerminalStore } from '@/stores/terminalStore';
import type { Event } from '@tauri-apps/api/event';
import type { AgentTerminalLeaseEvent } from '@/types/agent-session';
import {
  invokeAgentTerminalLeaseReady,
  invokeTakeoverAgentTerminal,
  listenToAgentTerminalLease,
} from '@/lib/ipc/tauri';

let leaseListener: ((event: Event<AgentTerminalLeaseEvent>) => void) | undefined;

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
  invokeSetSessionOutputPaused: vi.fn().mockResolvedValue(undefined),
  invokeWriteSession: vi.fn().mockResolvedValue(undefined),
  invokeResizeSession: vi.fn().mockResolvedValue(undefined),
  listenToSshData: vi.fn().mockResolvedValue(() => {}),
  listenToSshStatus: vi.fn().mockResolvedValue(() => {}),
  listenToSshClosed: vi.fn().mockResolvedValue(() => {}),
  invokeAgentTerminalLeaseReady: vi.fn().mockResolvedValue(true),
  invokeTakeoverAgentTerminal: vi.fn().mockResolvedValue(true),
  listenToAgentTerminalLease: vi.fn().mockImplementation(async (listener) => {
    leaseListener = listener;
    return () => {
      if (leaseListener === listener) leaseListener = undefined;
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

describe('TerminalControllerLayer', () => {
  beforeEach(() => {
    cleanupReact();
    terminalRegistry.disposeAll();
    vi.clearAllMocks();
    vi.mocked(invokeAgentTerminalLeaseReady).mockResolvedValue(true);
    vi.mocked(invokeTakeoverAgentTerminal).mockResolvedValue(true);
    vi.mocked(listenToAgentTerminalLease).mockImplementation(async (listener) => {
      leaseListener = listener;
      return () => {
        if (leaseListener === listener) leaseListener = undefined;
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
    expect(content).toContain('terminal.notice.disconnectedHint');
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
    vi.spyOn(controller, 'suppressUserInput').mockReturnValue(release);

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
    expect(release).toHaveBeenCalledOnce();
  });

  it('takes over at most once and stays locked until the matching release', async () => {
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
    await vi.waitFor(() => expect(invokeTakeoverAgentTerminal).toHaveBeenCalledOnce());
    expect(invokeTakeoverAgentTerminal).toHaveBeenCalledWith({
      sessionId: 's1',
      agentSessionId: 'agent-1',
      operationId: 'operation-1',
    });
    expect(release).not.toHaveBeenCalled();
    expect(agentTerminalLeaseState.get('s1')?.takeoverRequested).toBe(true);

    await coordinator.handle(leaseEvent('operation-old', 'released').payload);
    expect(release).not.toHaveBeenCalled();
    await coordinator.handle(leaseEvent('operation-1', 'released', { reason: 'takenOver' }).payload);
    expect(release).toHaveBeenCalledOnce();
    coordinator.dispose();
  });

  it('replaces resources by operation and ignores duplicate acquire and stale release events', async () => {
    const controller = seedController();
    act(() => {
      addSession('s1');
      useTerminalStore.getState().setStatus('s1', {
        sessionId: 's1',
        status: 'connected',
      });
    });
    const releaseFirst = vi.fn();
    const releaseSecond = vi.fn();
    const removeFirstFilter = vi.fn();
    const removeSecondFilter = vi.fn();
    const suppress = vi.spyOn(controller, 'suppressUserInput')
      .mockReturnValueOnce(releaseFirst)
      .mockReturnValueOnce(releaseSecond);
    const subscribeFilter = vi.spyOn(controller, 'subscribeOutputFilter')
      .mockReturnValueOnce(removeFirstFilter)
      .mockReturnValueOnce(removeSecondFilter);
    const coordinator = createAgentTerminalLeaseCoordinator();

    await coordinator.handle(leaseEvent('operation-1').payload);
    await coordinator.handle(leaseEvent('operation-1').payload);
    expect(suppress).toHaveBeenCalledOnce();
    expect(subscribeFilter).toHaveBeenCalledOnce();
    expect(subscribeFilter.mock.calls[0][0]).toMatchObject({ operationId: 'operation-1' });

    await coordinator.handle(leaseEvent('operation-2', 'acquired', {
      commandDisplay: '[Agent] $ safe command',
    }).payload);
    expect(releaseFirst).toHaveBeenCalledOnce();
    expect(removeFirstFilter).toHaveBeenCalledOnce();
    expect(agentTerminalLeaseState.get('s1')).toMatchObject({
      operationId: 'operation-2',
      commandDisplay: '[Agent] $ safe command',
    });

    await coordinator.handle(leaseEvent('operation-1', 'released').payload);
    expect(releaseSecond).not.toHaveBeenCalled();
    expect(agentTerminalLeaseState.get('s1')?.operationId).toBe('operation-2');

    await coordinator.handle(leaseEvent('operation-2', 'released').payload);
    expect(releaseSecond).toHaveBeenCalledOnce();
    expect(removeSecondFilter).toHaveBeenCalledOnce();
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
