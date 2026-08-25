import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Workbench from '../index';
import { useAppStore } from '@/stores/appStore';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}));

vi.mock('@/hooks/useConnectSession', () => ({
  useConnectSession: () => ({ connect: vi.fn() }),
}));

vi.mock('@/hooks/useSftpConnectionOpener', () => ({
  useSftpConnectionOpener: () => ({
    open: vi.fn(),
    hostKeyDialog: {
      open: false,
      host: '',
      port: 22,
      fingerprint: '',
      mismatch: false,
      onTrust: vi.fn(),
    },
    closeHostKeyDialog: vi.fn(),
  }),
}));

vi.mock('../connection-list', () => ({
  ConnectionList: () => <div data-testid="connection-list" />,
}));

vi.mock('../connection-form-drawer', () => ({
  ConnectionFormDrawer: ({ open }: { open: boolean }) => (
    open ? <div data-testid="connection-form-drawer" /> : null
  ),
}));

vi.mock('../known-hosts-panel', () => ({ KnownHostsPanel: () => null }));
vi.mock('../keychain-panel', () => ({ KeychainPanel: () => null }));
vi.mock('../log-panel', () => ({ LogPanel: () => null }));
vi.mock('../monitor-panel', () => ({ MonitorPanel: () => null }));
vi.mock('../settings-panel', () => ({ SettingsPanel: () => null }));
vi.mock('../runbook-panel', () => ({ RunbookPanel: () => null }));
vi.mock('../operation-history-panel', () => ({ OperationHistoryPanel: () => null }));
vi.mock('../connection-import-dialog', () => ({ ConnectionImportDialog: () => null }));

const initialAppState = useAppStore.getState();

describe('Workbench new connection request', () => {
  beforeEach(() => {
    useAppStore.setState(initialAppState, true);
  });

  it('opens the connection form and consumes a request from another section', async () => {
    render(<Workbench />);

    act(() => {
      useAppStore.getState().setActiveSection('terminal');
      useAppStore.getState().setActiveWorkbenchTab('settings');
      useAppStore.getState().requestNewConnection();
    });

    await waitFor(() => {
      expect(screen.getByTestId('connection-form-drawer')).toBeInTheDocument();
    });
    expect(useAppStore.getState()).toMatchObject({
      activeSection: 'workbench',
      activeWorkbenchTab: 'connections',
      pendingWorkbenchAction: null,
    });
  });
});
