// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '../test-utils';
import userEvent from '@testing-library/user-event';
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

const {
  emitSystemOpenSettings,
  listenMock,
  resetMockListeners,
} = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload?: unknown }) => void>();

  return {
    emitSystemOpenSettings: async () => {
      const handler = listeners.get('system-open-settings');
      if (!handler) {
        throw new Error('system-open-settings listener was not registered');
      }

      await act(async () => {
        handler({ payload: undefined });
      });
    },
    listenMock: vi.fn(async (event: string, handler: (event: { payload?: unknown }) => void) => {
      listeners.set(event, handler);
      return vi.fn(() => {
        listeners.delete(event);
      });
    }),
    resetMockListeners: () => listeners.clear(),
  };
});

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

vi.mock('../components/ConnectionForm', () => ({
  ConnectionForm: () => null,
}));

vi.mock('../components/FileManager', () => ({
  FileManager: () => null,
}));

vi.mock('../components/ui/Icons', () => ({
  CloseIcon: () => null,
  GlobeIcon: () => null,
  MoonIcon: () => null,
  PrimarySidebarIcon: () => null,
  PrimarySidebarActiveIcon: () => null,
  SecondarySidebarIcon: () => null,
  SecondarySidebarActiveIcon: () => null,
  SunIcon: () => null,
}));

vi.mock('../components/Sidebar', () => ({
  Sidebar: ({ onOpenConnect }: { onOpenConnect: () => void }) => (
    <div>
      <button onClick={onOpenConnect} type="button">
        新建连接
      </button>
    </div>
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

import App from '../App';

describe('App settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenMock.mockClear();
    resetMockListeners();
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  afterEach(() => {
    cleanup();
  });

  it('opens the settings dialog from the system menu event', async () => {
    render(<App />);

    expect(screen.getByText('开始一个新的远程工作区')).toHaveClass('themed-heading');

    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith('system-open-settings', expect.any(Function));
    });
    await emitSystemOpenSettings();

    expect(screen.getByRole('dialog', { name: '应用设置' })).toBeInTheDocument();
    expect(screen.getByLabelText('主题')).toBeInTheDocument();
  });

  it('switches locale with translated copy and persists the theme selection', async () => {
    render(<App />);

    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith('system-open-settings', expect.any(Function));
    });
    await emitSystemOpenSettings();
    let selects = await waitFor(() => {
      const s = document.querySelectorAll('select');
      expect(s.length).toBeGreaterThan(0);
      return s;
    });
    await userEvent.selectOptions(selects[0], 'light');
    const tabs = document.querySelectorAll('.settings-tab');
    expect(tabs.length).toBe(5);
    fireEvent.click(tabs[1]);
    selects = document.querySelectorAll('select');
    await userEvent.selectOptions(selects[0], 'en-US');

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(window.localStorage.getItem('termbridge.preferences')).toContain('"theme":"light"');
      expect(window.localStorage.getItem('termbridge.preferences')).toContain('"locale":"en-US"');
    });

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('Appearance')).toBeInTheDocument();
  });

  it('applies system theme mode and persists the system preference', async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-color-scheme: dark)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    render(<App />);

    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith('system-open-settings', expect.any(Function));
    });
    await emitSystemOpenSettings();
    await waitFor(() => {
      expect(document.querySelector('select')).toBeInTheDocument();
    });
    await userEvent.selectOptions(document.querySelector('select')!, 'system');

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(window.localStorage.getItem('termbridge.preferences')).toContain('"theme":"system"');
    });

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });
});
