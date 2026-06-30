// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { useTerminalSession } from '../useTerminalSession';
import type { SessionState } from '../../types';

const mockState = vi.hoisted(() => {
  const state: {
    terminalInstances: Array<{
      writes: string[];
      writeCalls: string[];
      onDataHandler?: (data: string) => void;
    }>;
    eventHandlers: Record<string, (event: { payload: any }) => void>;
    invokeMock: ReturnType<typeof vi.fn>;
  } = {
    terminalInstances: [],
    eventHandlers: {},
    invokeMock: vi.fn(),
  };
  return state;
});

const { MockTerminal } = vi.hoisted(() => {
  class MockTerminal {
    writes: string[];
    writeCalls: string[];
    onDataHandler?: (data: string) => void;

    constructor() {
      this.writes = [];
      this.writeCalls = [];
      mockState.terminalInstances.push(this);
    }

    write(message: string) {
      this.writeCalls.push(message);
    }

    writeln(message: string) {
      this.writes.push(message);
    }

    onData(handler: (data: string) => void) {
      this.onDataHandler = handler;
      return { dispose: () => {} };
    }

    dispose() {}

    get cols() {
      return 120;
    }

    get rows() {
      return 32;
    }
  }

  return { MockTerminal };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: MockTerminal,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mockState.invokeMock,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: any }) => void) => {
    mockState.eventHandlers[event] = handler;
    return () => {
      delete mockState.eventHandlers[event];
    };
  }),
}));

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../lib/tauri', () => ({
  isTauriRuntime: () => true,
}));

const baseSession: SessionState = {
  sessionId: 'session-1',
  title: 'demo',
  host: 'example.com',
  port: 22,
  username: 'root',
  profile: {
    id: 'profile-1',
    name: 'demo',
    host: 'example.com',
    port: 22,
    username: 'root',
    authMethod: 'password',
  },
  status: 'disconnected',
  createdAt: Date.now(),
};

describe('useTerminalSession', () => {
  beforeEach(() => {
    mockState.terminalInstances.length = 0;
    Object.keys(mockState.eventHandlers).forEach((key) => {
      delete mockState.eventHandlers[key];
    });
    mockState.invokeMock.mockReset();
    mockState.invokeMock.mockResolvedValue(undefined);
  });

  function useTestSession(session: SessionState, onReconnect: () => void) {
    const terminalRef = useRef<Terminal | null>(null);
    if (!terminalRef.current) {
      terminalRef.current = new MockTerminal() as unknown as Terminal;
    }
    const result = useTerminalSession({
      terminalRef,
      isAlive: () => terminalRef.current !== null,
      session,
      onReconnect,
    });
    return {
      terminal: terminalRef.current as unknown as InstanceType<typeof MockTerminal>,
      writeToSession: result.writeToSession,
    };
  }

  function setup(status: SessionState['status'] = 'disconnected') {
    const session = { ...baseSession, status };
    const onReconnect = vi.fn();
    const { result } = renderHook(() => useTestSession(session, onReconnect));
    return { ...result.current, session, onReconnect };
  }

  it('writes ssh-data chunks to the terminal', async () => {
    const { terminal } = setup('connected');

    await waitFor(() => {
      expect(mockState.eventHandlers['ssh-data']).toBeTypeOf('function');
    });

    mockState.eventHandlers['ssh-data']?.({
      payload: {
        sessionId: 'session-1',
        chunk: 'hello\r\n',
      },
    });

    expect(terminal?.writeCalls[0]).toBe('hello\r\n');
  });

  it('ignores ssh-data for other sessions', async () => {
    const { terminal } = setup('connected');

    await waitFor(() => {
      expect(mockState.eventHandlers['ssh-data']).toBeTypeOf('function');
    });

    mockState.eventHandlers['ssh-data']?.({
      payload: {
        sessionId: 'session-2',
        chunk: 'hello\r\n',
      },
    });

    expect(terminal?.writeCalls).toHaveLength(0);
  });

  it('writes status line when ssh-status is received', async () => {
    const { terminal } = setup('connecting');

    await waitFor(() => {
      expect(mockState.eventHandlers['ssh-status']).toBeTypeOf('function');
    });

    mockState.eventHandlers['ssh-status']?.({
      payload: {
        sessionId: 'session-1',
        status: 'connected',
        message: 'shell ready',
      },
    });

    expect(terminal?.writes[terminal.writes.length - 1]).toContain('[已连接]');
  });

  it('writes closed line and reconnect hint when ssh-closed is received', async () => {
    const { terminal } = setup('connected');

    await waitFor(() => {
      expect(mockState.eventHandlers['ssh-closed']).toBeTypeOf('function');
    });

    mockState.eventHandlers['ssh-closed']?.({
      payload: {
        sessionId: 'session-1',
        reason: 'Connection reset',
        reasonKind: 'transport_disconnect',
        retryable: true,
      },
    });

    expect(terminal?.writes[terminal.writes.length - 2]).toContain('[已关闭]');
    expect(terminal?.writes[terminal.writes.length - 1]).toContain('按回车重连');
  });

  it('writes user input to the session when connected', async () => {
    const { terminal } = setup('connected');

    await waitFor(() => {
      expect(terminal?.onDataHandler).toBeTypeOf('function');
    });

    terminal?.onDataHandler?.('ls -la\r');

    await waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith('write_session', {
        sessionId: 'session-1',
        data: 'ls -la\r',
      });
    });
  });

  it('shows disconnected hint on non-enter input', () => {
    const { terminal } = setup('disconnected');

    terminal?.onDataHandler?.('a');

    expect(terminal?.writes[terminal.writes.length - 1]).toContain('当前连接已断开');
  });

  it('triggers reconnect on Enter when disconnected', () => {
    const { terminal, onReconnect } = setup('disconnected');

    terminal?.onDataHandler?.('\r');

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('writeToSession forwards data via invoke when connected', async () => {
    const { writeToSession } = setup('connected');

    writeToSession('pwd\r');

    await waitFor(() => {
      expect(mockState.invokeMock).toHaveBeenCalledWith('write_session', {
        sessionId: 'session-1',
        data: 'pwd\r',
      });
    });
  });

  it('writeToSession writes locally when disconnected', () => {
    const { terminal, writeToSession } = setup('disconnected');

    writeToSession('local command\r');

    expect(terminal?.writeCalls[terminal.writeCalls.length - 1]).toBe('local command\r');
    expect(mockState.invokeMock).not.toHaveBeenCalled();
  });
});
