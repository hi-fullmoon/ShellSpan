// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '../types';

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Demo',
  host: 'example.com',
  port: 22,
  username: 'root',
  authMethod: 'password',
  rememberPassword: false,
  password: '',
  privateKeyPath: '',
  passphrase: '',
};

const {
  defaultListenImplementation,
  listenMock,
  removeSessionStateMock,
  replaceSessionStateKeyMock,
  resetMockListeners,
} = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload?: unknown }) => void>();

  const defaultListenImplementation = async (
    event: string,
    handler: (event: { payload?: unknown }) => void,
  ) => {
    listeners.set(event, handler);
    return vi.fn(() => {
      listeners.delete(event);
    });
  };

  return {
    defaultListenImplementation,
    listenMock: vi.fn(defaultListenImplementation),
    removeSessionStateMock: vi.fn(),
    replaceSessionStateKeyMock: vi.fn(),
    resetMockListeners: () => listeners.clear(),
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
}));

vi.mock('../hooks/useLocalStorage', () => ({
  useLocalStorage: () => [[], vi.fn()],
}));

vi.mock('../stores/fileManagerStore', () => ({
  useFileManagerStore: (selector: (value: { removeSessionState: typeof removeSessionStateMock; replaceSessionStateKey: typeof replaceSessionStateKeyMock }) => unknown) =>
    selector({
      removeSessionState: removeSessionStateMock,
      replaceSessionStateKey: replaceSessionStateKeyMock,
    }),
}));

vi.mock('../components/ConnectionForm', () => ({
  ConnectionForm: ({
    onConnect,
  }: {
    onConnect: (
      profile: ConnectionProfile,
      remember: boolean,
      rememberPassword: boolean,
    ) => void;
  }) => (
    <button
      onClick={() => onConnect(profile, false, false)}
      type="button"
    >
      创建连接
    </button>
  ),
}));

vi.mock('../components/FileManager', () => ({
  FileManager: () => null,
}));

vi.mock('../components/Icons', () => ({
  CloseIcon: () => null,
}));

vi.mock('../components/Sidebar', () => ({
  Sidebar: ({ onOpenConnect }: { onOpenConnect: () => void }) => (
    <button onClick={onOpenConnect} type="button">
      新建连接
    </button>
  ),
}));

vi.mock('../components/SplitLayout', () => ({
  SplitLayout: ({ primary, secondary }: { primary: React.ReactNode; secondary: React.ReactNode }) => (
    <div>
      <div>{primary}</div>
      <div>{secondary}</div>
    </div>
  ),
}));

vi.mock('../components/SessionTabs', () => ({
  SessionTabs: ({ sessions }: { sessions: Array<{ sessionId: string; title: string; status: string; note?: string }> }) => (
    <div>
      {sessions.map((session) => (
        <div key={session.sessionId}>
          {session.title}:{session.status}:{session.note ?? ''}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('../components/TerminalPane', () => ({
  TerminalPane: () => null,
}));

vi.mock('../components/Toast', () => ({
  Toast: () => null,
}));

vi.mock('../components/UpdateRestartDialog', () => ({
  UpdateRestartDialog: () => null,
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
  isTauriRuntime: () => true,
}));

vi.mock('../lib/updateStartupPolicy', () => ({
  markStartupUpdateCheck: vi.fn(),
  shouldRunStartupUpdateCheck: () => false,
}));

vi.mock('../lib/updater', () => ({
  checkForUpdate: vi.fn(async () => null),
  downloadAndInstallUpdate: vi.fn(),
}));

import App from '../App';

describe('App reconnect flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenMock.mockReset();
    listenMock.mockImplementation(defaultListenImplementation);
    resetMockListeners();
  });

  afterEach(() => {
    cleanup();
  });

  it('automatically reconnects once after a retryable transport disconnect', async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock
      .mockResolvedValueOnce({
        sessionId: 'session-1',
        title: 'Demo',
        host: 'example.com',
        port: 22,
        username: 'root',
      })
      .mockResolvedValueOnce({
        sessionId: 'session-2',
        title: 'Demo',
        host: 'example.com',
        port: 22,
        username: 'root',
      });

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '新建连接' }));
    });

    fireEvent.click(within(screen.getByRole('dialog', { name: 'Connect to server' })).getByRole('button', { name: '创建连接' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenNthCalledWith(1, 'create_session', expect.anything());
    });

    const closedHandler = listenMock.mock.calls.find(([eventName]) => eventName === 'ssh-closed')?.[1];
    expect(closedHandler).toBeTypeOf('function');

    await act(async () => {
      closedHandler?.({
        payload: {
          sessionId: 'session-1',
          reason: 'failed to read remote output: ssh transport disconnected',
          reasonKind: 'transport_disconnect',
          retryable: true,
        },
      });
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenNthCalledWith(2, 'create_session', expect.anything());
    });

    expect(replaceSessionStateKeyMock).toHaveBeenCalledWith('session-1', 'session-2');
  });

  it('does not auto reconnect for a non-retryable close reason', async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({
      sessionId: 'session-1',
      title: 'Demo',
      host: 'example.com',
      port: 22,
      username: 'root',
    });

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '新建连接' }));
    });

    fireEvent.click(within(screen.getByRole('dialog', { name: 'Connect to server' })).getByRole('button', { name: '创建连接' }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(1);
    });

    const closedHandler = listenMock.mock.calls.find(([eventName]) => eventName === 'ssh-closed')?.[1];
    expect(closedHandler).toBeTypeOf('function');

    await act(async () => {
      closedHandler?.({
        payload: {
          sessionId: 'session-1',
          reason: 'remote shell exited',
          reasonKind: 'remote_exit',
          retryable: false,
        },
      });
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
