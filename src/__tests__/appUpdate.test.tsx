// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '../test-utils';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const {
  checkForUpdateMock,
  defaultListenImplementation,
  downloadAndInstallUpdateMock,
  emitSystemCheckUpdate,
  emitSystemRequestAppExit,
  listenMock,
  loggerErrorMock,
  resetMockListeners,
  unlistenByEvent,
} = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload?: unknown }) => void>();
  const unlistenByEvent = new Map<string, ReturnType<typeof vi.fn>>();
  const loggerErrorMock = vi.fn();

  const defaultListenImplementation = async (event: string, handler: (event: { payload?: unknown }) => void) => {
    listeners.set(event, handler);
    const unlisten = vi.fn();
    unlistenByEvent.set(event, unlisten);
    return unlisten;
  };

  const listenMock = vi.fn(defaultListenImplementation);
  const resetMockListeners = () => listeners.clear();

  const emitSystemCheckUpdate = async () => {
    const handler = listeners.get('system-check-update');
    if (!handler) {
      throw new Error('system-check-update listener was not registered');
    }

    await act(async () => {
      handler({ payload: undefined });
    });
  };

  const emitSystemRequestAppExit = async () => {
    const handler = listeners.get('system-request-app-exit');
    if (!handler) {
      throw new Error('system-request-app-exit listener was not registered');
    }

    await act(async () => {
      handler({ payload: undefined });
    });
  };

  return {
    checkForUpdateMock: vi.fn(),
    defaultListenImplementation,
    downloadAndInstallUpdateMock: vi.fn(),
    emitSystemCheckUpdate,
    emitSystemRequestAppExit,
    listenMock,
    loggerErrorMock,
    resetMockListeners,
    unlistenByEvent,
  };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: listenMock,
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

vi.mock('../hooks/useLocalStorage', () => ({
  useLocalStorage: () => [[], vi.fn()],
}));

vi.mock('../stores/fileManagerStore', () => {
  const state = {
    removeSessionState: vi.fn(),
    replaceSessionStateKey: vi.fn(),
  };
  return {
    useFileManagerStore: (selector: (value: typeof state) => unknown) => selector(state),
  };
});

vi.mock('../components/ConnectionForm', () => ({
  ConnectionForm: () => null,
}));

vi.mock('../components/FileManager', () => ({
  FileManager: () => null,
}));

vi.mock('../components/Icons', () => ({
  CloseIcon: () => null,
  PrimarySidebarIcon: () => null,
  PrimarySidebarActiveIcon: () => null,
  SecondarySidebarIcon: () => null,
  SecondarySidebarActiveIcon: () => null,
}));

vi.mock('../components/Sidebar', () => ({
  Sidebar: () => null,
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

vi.mock('../components/Toast', () => ({
  Toast: ({ message, open }: { message: string; open: boolean }) => (open ? <div>{message}</div> : null),
  toaster: { create: vi.fn(), attrs: { overlap: false }, subscribe: () => () => {} },
}));

vi.mock('../components/UpdateRestartDialog', () => ({
  UpdateRestartDialog: () => null,
}));

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: loggerErrorMock,
  }),
}));

vi.mock('../lib/tauri', () => ({
  isTauriRuntime: () => true,
}));

vi.mock('../lib/update', async () => {
  const actual = await vi.importActual<typeof import('../lib/update')>('../lib/update');
  return {
    ...actual,
    markStartupUpdateCheck: vi.fn(),
    shouldRunStartupUpdateCheck: () => false,
    checkForUpdate: checkForUpdateMock,
    downloadAndInstallUpdate: downloadAndInstallUpdateMock,
  };
});

import App from '../App';

describe('App update listener', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenMock.mockReset();
    listenMock.mockImplementation(defaultListenImplementation);
    resetMockListeners();
    unlistenByEvent.clear();
    checkForUpdateMock.mockResolvedValue(null);
    downloadAndInstallUpdateMock.mockResolvedValue(undefined);
  });

  it('runs manual update check when system-check-update event is emitted', async () => {
    const { unmount } = render(<App />);

    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith('system-check-update', expect.any(Function));
    });

    await emitSystemCheckUpdate();

    await waitFor(() => {
      expect(checkForUpdateMock).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText('当前已是最新版本。')).toBeInTheDocument();

    unmount();
    expect(unlistenByEvent.get('system-check-update')).toHaveBeenCalledTimes(1);
  });

  it('handles system-check-update listener registration failure without unhandled rejection', async () => {
    listenMock.mockImplementation(async (event: string, handler: (event: { payload?: unknown }) => void) => {
      if (event === 'system-check-update') {
        throw new Error('register failed');
      }

      const unlisten = vi.fn();
      unlistenByEvent.set(event, unlisten);
      return unlisten;
    });

    render(<App />);

    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith('system-check-update', expect.any(Function));
    });

    await waitFor(() => {
      expect(loggerErrorMock).toHaveBeenCalledWith('监听系统更新检查事件失败', { error: 'Error: register failed' });
    });
  });

  it('shows an exit confirmation dialog when the system exit event is emitted', async () => {
    const invokeMock = vi.mocked(invoke);
    render(<App />);

    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith('system-request-app-exit', expect.any(Function));
    });

    await emitSystemRequestAppExit();

    expect(screen.getByRole('dialog', { name: '退出应用' })).toBeInTheDocument();
    expect(screen.getByText('确认退出 TermBridge 吗？退出后当前窗口和托盘都会关闭。')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '退出应用' }));
    });

    expect(invokeMock).toHaveBeenCalledWith('request_app_exit');
  });

  it('closes the exit confirmation dialog without exiting when cancelled', async () => {
    const invokeMock = vi.mocked(invoke);
    render(<App />);

    await emitSystemRequestAppExit();

    expect(screen.getByRole('dialog', { name: '退出应用' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
    });

    expect(screen.queryByRole('dialog', { name: '退出应用' })).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith('request_app_exit');
  });
});
