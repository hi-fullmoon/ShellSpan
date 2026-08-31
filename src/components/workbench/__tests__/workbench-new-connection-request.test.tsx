import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Workbench from '../index';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import type { ConnectionProfile } from '@/types';

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
  ConnectionList: ({
    profiles,
    onEdit,
  }: {
    profiles: ConnectionProfile[];
    onEdit: (profile: ConnectionProfile) => void;
  }) => (
    <div data-testid="connection-list">
      {profiles.map((profile) => (
        <button key={profile.id} type="button" onClick={() => onEdit(profile)}>
          edit {profile.id}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../connection-form-drawer', () => ({
  ConnectionFormDrawer: ({ open, initial }: { open: boolean; initial?: ConnectionProfile }) => (
    open ? (
      <div
        data-testid="connection-form-drawer"
        data-profile-id={initial?.id}
        data-password={initial?.password}
      />
    ) : null
  ),
}));

vi.mock('../known-hosts-panel', () => ({ KnownHostsPanel: () => null }));
vi.mock('../keychain-panel', () => ({ KeychainPanel: () => null }));
vi.mock('../log-panel', () => ({ LogPanel: () => null }));
vi.mock('../monitor-panel', () => ({ MonitorPanel: () => null }));
vi.mock('../settings-panel', () => ({ SettingsPanel: () => null }));
vi.mock('../connection-import-dialog', () => ({ ConnectionImportDialog: () => null }));

const initialAppState = useAppStore.getState();
const initialProfileState = useProfileStore.getState();

describe('Workbench new connection request', () => {
  beforeEach(() => {
    useAppStore.setState(initialAppState, true);
    useProfileStore.setState(initialProfileState, true);
  });

  it('opens the connection form and consumes a request from another section', async () => {
    render(<Workbench />);

    act(() => {
      useAppStore.getState().setActiveSection('terminal');
      useAppStore.getState().setActiveWorkbenchTab('logs');
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

  it('retrieves keychain secrets before opening an existing connection for editing', async () => {
    const storedProfile: ConnectionProfile = {
      id: 'profile-1',
      name: 'Production',
      host: 'prod.example.com',
      port: 22,
      username: 'deploy',
      authMethod: 'password',
      password: undefined,
      createdAt: 1,
      updatedAt: 1,
    };
    const ensurePassword = vi.fn().mockResolvedValue({
      ...storedProfile,
      password: 'saved-secret',
    });
    useProfileStore.setState({
      profiles: [storedProfile],
      initialized: true,
      ensurePassword,
    });

    render(<Workbench />);
    fireEvent.click(screen.getByRole('button', { name: 'edit profile-1' }));

    await waitFor(() => {
      expect(ensurePassword).toHaveBeenCalledWith(storedProfile);
      expect(screen.getByTestId('connection-form-drawer')).toHaveAttribute(
        'data-password',
        'saved-secret',
      );
    });
  });
});
