import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostQuickActionsDialog } from '@/components/workbench/host-quick-actions-dialog';
import { initI18n } from '@/locales';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { ConnectionProfile } from '@/types';

const profile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Production',
  host: 'prod.example.test',
  port: 22,
  username: 'deploy',
  authMethod: 'password',
  createdAt: 1,
  updatedAt: 1,
};

describe('HostQuickActionsDialog', () => {
  const updateProfile = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    vi.clearAllMocks();
    updateProfile.mockResolvedValue(undefined);
    await initI18n('en-US');
    useAppStore.setState({ locale: 'en-US' });
    useProfileStore.setState({ profiles: [profile], updateProfile });
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
  });

  it('creates a host-bound directory action through the managed form', async () => {
    render(<HostQuickActionsDialog profile={profile} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add quick action' }));
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
    render(<HostQuickActionsDialog profile={profile} onClose={vi.fn()} />);

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

  it('disables command insertion when this host has no connected terminal', () => {
    const withCommand: ConnectionProfile = {
      ...profile,
      quickActions: [{
        id: 'command-1',
        kind: 'command',
        label: 'Check status',
        command: 'systemctl status api',
      }],
    };
    useProfileStore.setState({ profiles: [withCommand], updateProfile });
    render(<HostQuickActionsDialog profile={withCommand} onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Insert only' })).toBeDisabled();
    expect(screen.getByText(/never sends Enter/i)).toBeInTheDocument();
  });
});
