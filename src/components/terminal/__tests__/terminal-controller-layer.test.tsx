import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { TerminalControllerLayer } from '../terminal-controller-layer';
import { terminalRegistry } from '../registry/terminal-registry';
import { useTerminalStore } from '@/stores/terminalStore';

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = (globalThis.ResizeObserver ?? RO) as typeof ResizeObserver;

vi.mock('@/lib/tauri', () => ({
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

describe('TerminalControllerLayer', () => {
  beforeEach(() => {
    useTerminalStore.setState(initialState, true);
    terminalRegistry.disposeAll();
  });

  afterEach(() => {
    terminalRegistry.disposeAll();
  });

  it('creates a controller when a session is added', () => {
    render(<TerminalControllerLayer />);
    expect(terminalRegistry.get('s1')).toBeUndefined();
    act(() => {
      addSession('s1');
    });
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
});
