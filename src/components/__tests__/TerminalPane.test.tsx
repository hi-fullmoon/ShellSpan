// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../../types';
import { TerminalPane } from '../TerminalPane';

const { MockTerminal, terminalInstances, eventHandlers } = vi.hoisted(() => {
  const terminalInstances: Array<{
    options: { disableStdin?: boolean };
    writes: string[];
    writeCalls: string[];
    onDataHandler?: (data: string) => void;
  }> = [];
  const eventHandlers: Record<string, (event: { payload: any }) => void> = {};

  class MockTerminal {
    options: { disableStdin?: boolean };
    writes: string[];
    writeCalls: string[];
    onDataHandler?: (data: string) => void;

    constructor(options: { disableStdin?: boolean }) {
      this.options = { ...options };
      this.writes = [];
      this.writeCalls = [];
      terminalInstances.push(this);
    }

    loadAddon() {}

    open() {}

    write(message: string) {
      this.writeCalls.push(message);
    }

    writeln(message: string) {
      this.writes.push(message);
    }

    focus() {}

    onData(handler: (data: string) => void) {
      this.onDataHandler = handler;
      return { dispose() {} };
    }

    dispose() {}

    get cols() {
      return 120;
    }

    get rows() {
      return 32;
    }
  }

  return { MockTerminal, terminalInstances, eventHandlers };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: MockTerminal,
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: any }) => void) => {
    eventHandlers[event] = handler;
    return () => {
      delete eventHandlers[event];
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

const session: SessionState = {
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

describe('TerminalPane', () => {
  beforeEach(() => {
    terminalInstances.length = 0;
    Object.keys(eventHandlers).forEach((key) => {
      delete eventHandlers[key];
    });
    vi.clearAllMocks();
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as typeof ResizeObserver;
  });

  it('keeps stdin enabled after disconnection so enter can trigger reconnect', () => {
    render(<TerminalPane active onReconnect={() => {}} session={session} />);

    expect(terminalInstances).toHaveLength(1);
    expect(terminalInstances[0]?.options.disableStdin).toBe(false);
  });

  it('shows the initial terminal preparation line with the termbridge prefix', () => {
    render(<TerminalPane active onReconnect={() => {}} session={session} />);

    expect(terminalInstances[0]?.writes[0]).toBe(
      '\u001b[36m[termbridge]\u001b[0m 终端准备中...',
    );
  });

  it('shows the reconnect line with the termbridge prefix', () => {
    const onReconnect = vi.fn();
    render(<TerminalPane active onReconnect={onReconnect} session={session} />);

    terminalInstances[0]?.onDataHandler?.('\r');

    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(
      terminalInstances[0]?.writes[terminalInstances[0].writes.length - 1],
    ).toBe(
      '\u001b[36m[termbridge]\u001b[0m \u001b[36m[重连中]\u001b[0m 正在重新连接...',
    );
  });

  it('shows the disconnected hint with the termbridge prefix', () => {
    render(<TerminalPane active onReconnect={() => {}} session={session} />);

    terminalInstances[0]?.onDataHandler?.('a');

    expect(
      terminalInstances[0]?.writes[terminalInstances[0].writes.length - 1],
    ).toBe(
      '\u001b[36m[termbridge]\u001b[0m \u001b[33m[提示]\u001b[0m 当前连接已断开，按回车重连。',
    );
  });

  it('adds a blank line between connected status and the first shell output', async () => {
    render(<TerminalPane active onReconnect={() => {}} session={session} />);

    await waitFor(() => {
      expect(eventHandlers['ssh-status']).toBeTypeOf('function');
      expect(eventHandlers['ssh-data']).toBeTypeOf('function');
    });

    eventHandlers['ssh-status']?.({
      payload: {
        sessionId: 'session-1',
        status: 'connected',
        message: 'shell ready',
      },
    });

    eventHandlers['ssh-data']?.({
      payload: {
        sessionId: 'session-1',
        chunk: 'Welcome to TencentOS Server 4 x86_64\r\n',
      },
    });

    expect(terminalInstances[0]?.writes[1]).toBe(
      '\u001b[36m[termbridge]\u001b[0m \u001b[33m[已连接]\u001b[0m 终端已就绪',
    );
    expect(terminalInstances[0]?.writeCalls[0]).toBe('\r\n');
    expect(terminalInstances[0]?.writeCalls[1]).toBe(
      'Welcome to TencentOS Server 4 x86_64\r\n',
    );
  });
});
