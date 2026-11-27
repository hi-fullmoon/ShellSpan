import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostQuickActionsPanel } from '../host-quick-actions-panel';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useWorkbenchToolsStore } from '@/stores/workbenchToolsStore';
import type { ConnectionProfile } from '@/types';

const prodProfile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Production',
  host: 'prod.example.test',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  createdAt: 1,
  updatedAt: 1,
};

const stagingProfile: ConnectionProfile = {
  id: 'profile-2',
  name: 'Staging',
  host: 'staging.example.test',
  port: 22,
  username: 'ops',
  authMethod: 'key',
  quickActions: [
    {
      id: 'dir-1',
      kind: 'directory',
      label: 'Nginx Config',
      path: '/etc/nginx',
      target: 'sftp',
    },
  ],
  createdAt: 2,
  updatedAt: 2,
};

describe('HostQuickActionsPanel', () => {
  const updateProfile = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    vi.clearAllMocks();
    updateProfile.mockResolvedValue(undefined);
    await initI18n('en-US');
    useAppStore.setState({ locale: 'en-US' });
    useProfileStore.setState({ profiles: [prodProfile], updateProfile });
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
    useWorkbenchToolsStore.setState({
      portForwardProfileId: 'all',
      quickActionsProfileId: 'all',
      overviewProfileId: null,
      pendingPortForwardDraft: null,
    });
  });

  it('creates a host-bound directory action through the right-side Drawer', async () => {
    render(<HostQuickActionsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Add quick action' }));
    const drawer = screen.getByRole('dialog');
    expect(drawer).toHaveAttribute('data-slot', 'drawer-content');
    expect(drawer.querySelector('[data-slot="drawer-footer"]')).not.toHaveClass('border-t');
    expect(drawer.querySelector('[data-slot="scroll-area"]')).toHaveClass('min-h-0', 'flex-1');
    expect(screen.getByText(/never sends Enter/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Releases' } });
    fireEvent.change(screen.getByLabelText('Remote path'), { target: { value: '/srv/releases' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledWith('profile-1', {
        quickActions: [expect.objectContaining({
          kind: 'directory',
          label: 'Releases',
          path: '/srv/releases',
          target: 'terminal',
        })],
      });
    });
  });

  it('blocks secret-bearing snippets before persistence', async () => {
    render(<HostQuickActionsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Add quick action' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Unsafe' } });
    fireEvent.click(screen.getByRole('button', { name: 'Command snippet' }));
    fireEvent.change(screen.getByLabelText('Command text'), {
      target: { value: 'curl --api-key plaintext https://example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/looks like a password, token, or private key/i)).toBeInTheDocument();
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('filters across hosts and kinds with readable Select labels', () => {
    const withCommand: ConnectionProfile = {
      ...prodProfile,
      quickActions: [{
        id: 'command-1',
        kind: 'command',
        label: 'Check status',
        command: 'systemctl status api',
      }],
    };
    useProfileStore.setState({ profiles: [withCommand, stagingProfile], updateProfile });
    render(<HostQuickActionsPanel />);

    expect(screen.getByRole('combobox', { name: 'Filter by host' })).toHaveTextContent('All hosts');
    expect(screen.getByText('Check status')).toBeInTheDocument();
    expect(screen.getByText('Nginx Config')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Directory' }));
    expect(screen.queryByText('Check status')).not.toBeInTheDocument();
    expect(screen.getByText('Nginx Config')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    act(() => {
      useWorkbenchToolsStore.getState().selectQuickActionsProfile(prodProfile.id);
    });
    expect(screen.getByRole('combobox', { name: 'Filter by host' })).toHaveTextContent('Production');
    expect(screen.getByText('Check status')).toBeInTheDocument();
    expect(screen.queryByText('Nginx Config')).not.toBeInTheDocument();
  });

  it('disables command insertion when the host has no connected writable terminal', () => {
    const withCommand: ConnectionProfile = {
      ...prodProfile,
      quickActions: [{
        id: 'command-1',
        kind: 'command',
        label: 'Check status',
        command: 'systemctl status api',
      }],
    };
    useProfileStore.setState({ profiles: [withCommand], updateProfile });
    useTerminalStore.setState({
      sessions: [{
        sessionId: 's-ro',
        profileId: withCommand.id,
        title: withCommand.name,
        host: withCommand.host,
        port: withCommand.port,
        username: withCommand.username,
        status: 'connected',
        readOnly: true,
      }],
      activeSessionId: 's-ro',
    });

    render(<HostQuickActionsPanel />);

    expect(screen.getByRole('button', { name: 'Insert only' })).toBeDisabled();
    const card = screen.getByText('Check status').closest('[data-slot="card"]');
    expect(card).toHaveAttribute('data-size', 'sm');
    expect(card).toHaveAttribute('data-radius', 'compact');
  });
});
