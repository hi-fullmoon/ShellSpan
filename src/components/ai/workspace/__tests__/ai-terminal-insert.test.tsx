import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentTerminalLeaseState } from '@/components/terminal/agent-terminal-lease-state';
import { terminalInputReadiness } from '@/components/terminal/terminal-input-readiness';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { useAppStore } from '@/stores/appStore';
import { useTerminalStore, type TerminalSession } from '@/stores/terminalStore';
import { insertCommandIntoTerminal, useTerminalInsertTarget } from '../ai-terminal-insert';

function makeSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    sessionId: 'term-1',
    title: 'prod-web-01',
    host: '10.0.0.10',
    port: 22,
    username: 'ops',
    status: 'connected',
    ...overrides,
  };
}

describe('ai-terminal-insert', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    agentTerminalLeaseState.clearAll();
    terminalInputReadiness.finish('term-1');
    useTerminalStore.setState({
      sessions: [makeSession()],
      activeSessionId: 'other-term',
    });
    useAppStore.setState({ activeSection: 'workbench' });
  });

  afterEach(() => {
    agentTerminalLeaseState.clearAll();
    terminalInputReadiness.finish('term-1');
    vi.restoreAllMocks();
  });

  it('hides the insert target while the terminal is leased by an agent and restores it on release', () => {
    const { result } = renderHook(() => useTerminalInsertTarget('term-1'));
    expect(result.current).toEqual({ sessionId: 'term-1', targetName: 'prod-web-01' });

    act(() => {
      agentTerminalLeaseState.set({
        sessionId: 'term-1',
        agentSessionId: 'agent-1',
        taskId: 'task-1',
        operationId: 'op-1',
        acquiredAtUnixMs: Date.now(),
        state: 'acquired',
        terminalOwned: true,
        inputBlocked: true,
        takeoverRequested: false,
        takeoverFailed: false,
        requestTakeover: () => {},
      });
    });
    expect(result.current).toBeNull();

    act(() => {
      agentTerminalLeaseState.clear('term-1', 'op-1');
    });
    expect(result.current).toEqual({ sessionId: 'term-1', targetName: 'prod-web-01' });
  });

  it('pastes a sanitized single-line command without newline, focuses the terminal, and switches section', () => {
    const focus = vi.fn();
    const paste = vi.fn();
    vi.spyOn(terminalRegistry, 'get').mockReturnValue({
      terminal: { focus, paste },
    } as unknown as ReturnType<typeof terminalRegistry.get>);

    expect(insertCommandIntoTerminal('term-1', 'systemctl status nginx\n')).toBe(true);
    expect(useTerminalStore.getState().activeSessionId).toBe('term-1');
    expect(useAppStore.getState().activeSection).toBe('terminal');
    expect(focus).toHaveBeenCalledOnce();
    expect(paste).toHaveBeenCalledExactlyOnceWith('systemctl status nginx');

    focus.mockClear();
    paste.mockClear();
    expect(insertCommandIntoTerminal('term-1', 'echo a\necho b')).toBe(false);
    expect(paste).not.toHaveBeenCalled();
  });
});
