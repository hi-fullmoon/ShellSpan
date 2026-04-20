// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const { emitSystemOpenSettings, listenMock, resetMockListeners } = vi.hoisted(() => {
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

vi.mock('../components/ConnectionForm', () => ({
  ConnectionForm: () => null,
}));

vi.mock('../components/FileManager', () => ({
  FileManager: () => null,
}));

vi.mock('../components/Icons', () => ({
  CloseIcon: () => null,
  GlobeIcon: () => null,
  MoonIcon: () => null,
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

vi.mock('../components/SplitLayout', () => ({
  SplitLayout: ({ primary, secondary }: { primary: React.ReactNode; secondary: React.ReactNode }) => (
    <div>
      <div>{primary}</div>
      <div>{secondary}</div>
    </div>
  ),
}));

vi.mock('../components/SessionTabs', () => ({
  SessionTabs: () => null,
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
    expect(screen.getByLabelText('语言')).toBeInTheDocument();
  });

  it('switches locale with translated copy and persists the theme selection', async () => {
    render(<App />);

    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith('system-open-settings', expect.any(Function));
    });
    await emitSystemOpenSettings();
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: 'light' } });
    fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en-US' } });

    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(window.localStorage.getItem('termbridge.preferences')).toContain('"theme":"light"');
      expect(window.localStorage.getItem('termbridge.preferences')).toContain('"locale":"en-US"');
    });

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('Appearance')).toBeInTheDocument();
  });
});
