// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from '../../types';
import { TerminalPane } from '../TerminalPane';

const { MockTerminal, terminalInstances } = vi.hoisted(() => {
  const terminalInstances: Array<{ options: { disableStdin?: boolean } }> = [];

  class MockTerminal {
    options: { disableStdin?: boolean };

    constructor(options: { disableStdin?: boolean }) {
      this.options = { ...options };
      terminalInstances.push(this);
    }

    loadAddon() {}

    open() {}

    writeln() {}

    focus() {}

    onData() {
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

  return { MockTerminal, terminalInstances };
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
  listen: vi.fn(async () => () => {}),
}));

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../lib/tauri', () => ({
  isTauriRuntime: () => false,
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
});
