import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostQuickActionsPanel } from '../host-quick-actions-panel';
import {
  WORKBENCH_VIEW_STORAGE_KEYS,
  readWorkbenchViewMode,
  saveWorkbenchViewMode,
} from '../workbench-view-mode';
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
    saveWorkbenchViewMode(WORKBENCH_VIEW_STORAGE_KEYS.quickActions, 'card');
    updateProfile.mockResolvedValue(undefined);
    await initI18n('en-US');
    useAppStore.setState({ locale: 'en-US' });
    useProfileStore.setState({ profiles: [prodProfile], initialized: true, updateProfile });
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

    const labelInput = screen.getByLabelText('Label');
    const pathInput = screen.getByLabelText('Remote path');
    expect(labelInput).toHaveValue('');
    expect(labelInput).toHaveAttribute('placeholder', 'e.g. App logs');
    expect(pathInput).toHaveValue('');
    expect(pathInput).toHaveAttribute('placeholder', '/var/log/nginx');

    fireEvent.click(screen.getByRole('button', { name: 'Command snippet' }));
    expect(screen.getByLabelText('Label')).toHaveAttribute('placeholder', 'e.g. Check Nginx status');
    expect(screen.getByLabelText('Command text')).toHaveAttribute('placeholder', 'systemctl status nginx');

    fireEvent.click(screen.getByRole('button', { name: 'Connection action' }));
    expect(screen.getByLabelText('Label')).toHaveAttribute('placeholder', 'e.g. Open host overview');

    fireEvent.click(screen.getByRole('button', { name: 'Directory' }));
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
    const card = screen.getByText('Check status').closest('[data-slot="management-card"]');
    expect(card).toHaveClass('rounded-lg', 'border', 'bg-app-surface', 'p-2.5');
    expect(document.querySelector('[title]')).toBeNull();
  });

  it('requires confirmation before deleting a quick action', async () => {
    useProfileStore.setState({ profiles: [stagingProfile], updateProfile });
    render(<HostQuickActionsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(updateProfile).not.toHaveBeenCalled();

    const alertDialog = await screen.findByRole('alertdialog');
    expect(alertDialog).toHaveTextContent('Delete quick action?');
    expect(alertDialog).toHaveTextContent('Nginx Config');

    const confirmButtons = screen.getAllByRole('button', { name: 'Delete' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(updateProfile).toHaveBeenCalledWith(stagingProfile.id, {
        quickActions: [],
      });
    });
  });

  it('shows a loading state while profiles are still hydrating', () => {
    useProfileStore.setState({ profiles: [], initialized: false, updateProfile });
    const { container } = render(<HostQuickActionsPanel />);

    expect(container.querySelector('svg.animate-spin')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="panel-empty-state"]')).toBeNull();
    expect(screen.queryByText('No hosts available')).not.toBeInTheDocument();
  });

  it('switches to table view, sorts rows, and persists the preference locally', () => {
    const withActions: ConnectionProfile = {
      ...prodProfile,
      quickActions: [
        { id: 'cmd-1', kind: 'command', label: 'Zeta Status', command: 'uptime' },
        { id: 'dir-2', kind: 'directory', label: 'Alpha Logs', path: '/var/log', target: 'terminal' },
      ],
    };
    useProfileStore.setState({ profiles: [withActions, stagingProfile], initialized: true, updateProfile });

    const { unmount } = render(<HostQuickActionsPanel />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Table view' }));
    expect(readWorkbenchViewMode(WORKBENCH_VIEW_STORAGE_KEYS.quickActions)).toBe('table');

    const table = screen.getByRole('table', { name: 'Quick actions' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);

    const sortByName = within(table).getByRole('button', { name: 'Sort by Action' });
    fireEvent.click(sortByName);
    const names = () => within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.querySelector('td')?.textContent ?? '');
    expect(names()[0]).toContain('Alpha Logs');
    expect(names()[1]).toContain('Nginx Config');
    expect(names()[2]).toContain('Zeta Status');

    unmount();
    render(<HostQuickActionsPanel />);
    expect(screen.getByRole('table', { name: 'Quick actions' })).toBeInTheDocument();
  });
});
