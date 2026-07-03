// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '../test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@chakra-ui/react', async () => {
  const actual = await vi.importActual('@chakra-ui/react');
  return {
    ...(actual as object),
    Toaster: () => null,
    Toast: {
      Root: () => null,
      Indicator: () => null,
      Title: () => null,
      Description: () => null,
      ActionTrigger: () => null,
      CloseTrigger: () => null,
    },
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTheme: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockReturnValue(Promise.resolve(vi.fn())),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock('../lib/tauri', () => ({
  isTauriRuntime: () => true,
}));

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../lib/update', async () => {
  const actual = await vi.importActual<typeof import('../lib/update')>('../lib/update');
  return {
    ...actual,
    markStartupUpdateCheck: vi.fn(),
    shouldRunStartupUpdateCheck: () => false,
    checkForUpdate: vi.fn(async () => null),
    downloadAndInstallUpdate: vi.fn(),
  };
});

vi.mock('../hooks/useLocalStorage', () => ({
  useLocalStorage: () => [[], vi.fn()],
}));

vi.mock('../stores/fileManagerStore', () => ({
  useFileManagerStore: (selector: (value: { removeSessionState: typeof vi.fn; replaceSessionStateKey: typeof vi.fn }) => unknown) =>
    selector({
      removeSessionState: vi.fn(),
      replaceSessionStateKey: vi.fn(),
    }),
}));

vi.mock('../components/FileManager', () => ({
  FileManager: () => null,
}));

vi.mock('../components/ui/Icons', () => ({
  CloseIcon: () => null,
  PrimarySidebarIcon: () => null,
  PrimarySidebarActiveIcon: () => null,
  SecondarySidebarIcon: () => null,
  SecondarySidebarActiveIcon: () => null,
}));

vi.mock('../components/Sidebar', () => ({
  Sidebar: ({
    onOpenConnect,
  }: {
    onOpenConnect: () => void;
  }) => (
    <button onClick={onOpenConnect} type="button">
      新建连接
    </button>
  ),
}));

vi.mock('../components/SplitLayout', () => {
  function Slot({ children }: { children: React.ReactNode | ((props: { collapsed: boolean; size: number }) => React.ReactNode) }) {
    return <div>{typeof children === 'function' ? children({ collapsed: false, size: 320 }) : children}</div>;
  }
  function SplitLayout({ children }: { children: React.ReactNode }) {
    return <div>{children}</div>;
  }
  SplitLayout.Slot = Slot;
  return { SplitLayout };
});

vi.mock('../components/SessionTabs', () => ({
  SessionTabs: () => null,
}));

vi.mock('../components/TerminalPane', () => ({
  TerminalPane: () => null,
}));

vi.mock('../components/ui/Toast', () => ({
  Toast: () => null,
  toaster: { create: vi.fn(), attrs: { overlap: false }, subscribe: () => () => {} },
}));

vi.mock('../components/UpdateRestartDialog', () => ({
  UpdateRestartDialog: () => null,
}));

import { invoke } from '@tauri-apps/api/core';
import App from '../App';

function fillConnectionForm(host: string, username: string) {
  const [hostInput] = screen.getAllByPlaceholderText('192.168.1.10 / server.example.com');
  const [usernameInput] = screen.getAllByPlaceholderText('root / ubuntu / deploy');

  fireEvent.change(hostInput, { target: { value: host } });
  fireEvent.change(usernameInput, { target: { value: username } });
}

describe('Host key dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows HostKeyDialog when check_host_key returns notFound', async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockResolvedValueOnce({
      status: 'notFound',
      fingerprint: 'RSA SHA256:abc123',
    });

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '新建连接' }));
    });

    fillConnectionForm('example.com', 'root');
    fireEvent.click(screen.getByRole('button', { name: '启动连接' }));

    await waitFor(() => {
      expect(screen.getByText('首次连接到 "example.com"')).toBeInTheDocument();
    });

    expect(screen.getByText('RSA SHA256:abc123')).toBeInTheDocument();
  });

  it('shows HostKeyDialog when create_session returns host key unknown error', async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock
      .mockResolvedValueOnce({
        status: 'match',
        fingerprint: 'RSA SHA256:abc123',
      })
      .mockRejectedValueOnce({
        type: 'hostKeyUnknown',
        payload: {
          host: 'example.com',
          port: 22,
          fingerprint: 'RSA SHA256:def456',
        },
      });

    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '新建连接' }));
    });

    fillConnectionForm('example.com', 'root');
    fireEvent.click(screen.getByRole('button', { name: '启动连接' }));

    await waitFor(() => {
      expect(screen.getByText('首次连接到 "example.com"')).toBeInTheDocument();
    });

    expect(screen.getByText('RSA SHA256:def456')).toBeInTheDocument();
  });
});
