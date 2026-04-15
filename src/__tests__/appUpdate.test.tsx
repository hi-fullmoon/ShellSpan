// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkForUpdateMock, downloadAndInstallUpdateMock, emitSystemCheckUpdate, listenMock, unlistenByEvent } = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload?: unknown }) => void>();
  const unlistenByEvent = new Map<string, ReturnType<typeof vi.fn>>();

  const listenMock = vi.fn(async (event: string, handler: (event: { payload?: unknown }) => void) => {
    listeners.set(event, handler);
    const unlisten = vi.fn();
    unlistenByEvent.set(event, unlisten);
    return unlisten;
  });

  const emitSystemCheckUpdate = async () => {
    const handler = listeners.get('system-check-update');
    if (!handler) {
      throw new Error('system-check-update listener was not registered');
    }

    await act(async () => {
      handler({ payload: undefined });
    });
  };

  return {
    checkForUpdateMock: vi.fn(),
    downloadAndInstallUpdateMock: vi.fn(),
    emitSystemCheckUpdate,
    listenMock,
    unlistenByEvent,
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
}));

vi.mock('../components/Sidebar', () => ({
  Sidebar: () => null,
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
  Toast: ({ message, open }: { message: string; open: boolean }) => (open ? <div>{message}</div> : null),
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
  checkForUpdate: checkForUpdateMock,
  downloadAndInstallUpdate: downloadAndInstallUpdateMock,
}));

import App from '../App';

describe('App update listener', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
