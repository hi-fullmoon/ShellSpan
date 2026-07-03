// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '../test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '../types';

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

const savedProfile: ConnectionProfile = {
  id: 'saved-profile-1',
  name: 'Prod Server',
  host: 'prod.example.com',
  port: 2222,
  username: 'deploy',
  authMethod: 'password',
  pinned: false,
  favorite: false,
  rememberPassword: true,
  password: 'secret',
  privateKeyPath: '',
  passphrase: '',
};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock('../hooks/useLocalStorage', () => ({
  useLocalStorage: () => [[savedProfile], vi.fn()],
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
  ConnectionForm: ({
    profile,
  }: {
    profile: ConnectionProfile;
  }) => (
    <div>
      <div data-testid="profile-name">{profile.name}</div>
      <div data-testid="profile-host">{profile.host}</div>
    </div>
  ),
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
    onReuseProfile,
  }: {
    onOpenConnect: () => void;
    onReuseProfile: (profile: ConnectionProfile) => void;
  }) => (
    <div>
      <button onClick={() => onReuseProfile(savedProfile)} type="button">
        打开历史连接
      </button>
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
  isTauriRuntime: () => false,
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

describe('App connect dialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resets the draft profile when opening a new connection after reusing history', async () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '打开历史连接' }));

    await waitFor(() => {
      expect(screen.getByTestId('profile-name')).toHaveTextContent('Prod Server');
    });
    expect(screen.getByTestId('profile-host')).toHaveTextContent('prod.example.com');

    fireEvent.click(screen.getByRole('button', { name: '关闭连接弹框' }));
    fireEvent.click(screen.getByRole('button', { name: '新建连接' }));

    await waitFor(() => {
      expect(screen.getByTestId('profile-name')).toHaveTextContent('New Session');
    });
    expect(screen.getByTestId('profile-host')).toHaveTextContent('');
  });
});
