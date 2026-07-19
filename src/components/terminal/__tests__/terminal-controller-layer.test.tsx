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

  it('renders null', () => {
    const { container } = render(<TerminalControllerLayer />);
    expect(container.firstChild).toBeNull();
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
