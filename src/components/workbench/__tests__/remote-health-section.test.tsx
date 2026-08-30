import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteHealthSection } from '../remote-health-section';
import { useProfileStore } from '@/stores/profileStore';
import { useRemoteHealthStore } from '@/stores/remoteHealthStore';
import type {
  ConnectionProfile,
  RemoteHealthSnapshotResult,
} from '@/types';

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string, variables?: Record<string, string | number>) => variables
      ? `${key}:${Object.values(variables).join(':')}`
      : key,
    ready: true,
    locale: 'en-US',
    setLocale: () => {},
  }),
}));

const profile: ConnectionProfile = {
  id: 'profile-health',
  name: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'root',
  authMethod: 'password',
  createdAt: 0,
  updatedAt: 0,
};

beforeEach(() => {
  useProfileStore.setState({ profiles: [profile], initialized: true });
  useRemoteHealthStore.setState({ entries: {}, selectedProfileId: profile.id });
});

describe('RemoteHealthSection authorization', () => {
  it('shows the profile label instead of its internal ID in the target select', () => {
    render(<RemoteHealthSection />);

    const select = screen.getByRole('combobox', { name: 'remoteHealth.profile' });
    expect(select).toHaveTextContent('Production · root@prod.example.com:22');
    expect(select).not.toHaveTextContent(profile.id);
    expect(select).toHaveClass('w-full', 'sm:w-72');
  });

  it('does not collect until the user approves the one-shot read-only scope', async () => {
    const result: RemoteHealthSnapshotResult = {
      operationId: 'remote-health:test',
      profileId: profile.id,
      status: 'cancelled',
      checkedAt: Date.now(),
      source: {
        kind: 'sshReadOnly',
        commandSetVersion: 'termbridge-read-only-v1',
        profileId: profile.id,
        host: profile.host,
        port: profile.port,
        username: profile.username,
      },
    };
    const collect = vi.fn().mockResolvedValue(result);
    useRemoteHealthStore.setState({ collect });
    render(<RemoteHealthSection />);

    const collectButton = screen.getByRole('button', { name: 'remoteHealth.collect' });
    expect(collectButton).toHaveClass('h-8');
    expect(collectButton.closest('[data-slot="card-footer"]')).toBeNull();
    expect(collectButton.closest('[data-slot="card-action"]')).toBeNull();
    expect(collectButton.closest('[data-slot="remote-health-section-header"]'))
      .toBeInTheDocument();
    expect(document.querySelector('[data-slot="remote-health-actions"]')).toBeNull();
    fireEvent.click(collectButton);
    expect(collect).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveClass('max-h-[min(720px,calc(100vh-2rem))]', 'overflow-hidden');
    expect(within(dialog).getByText(/root@prod\.example\.com:22/)).toBeInTheDocument();
    expect(within(dialog).getByText('remoteHealth.authorization.scope')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', {
      name: 'remoteHealth.authorization.confirm',
    });
    expect(confirm.querySelector('svg')).toBeNull();
    fireEvent.click(confirm);

    await waitFor(() => expect(collect).toHaveBeenCalledOnce());
    expect(collect).toHaveBeenCalledWith(profile, true);
  });

  it('keeps cancel next to the active collection control', () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    useRemoteHealthStore.setState({
      cancel,
      entries: {
        [profile.id]: {
          profileId: profile.id,
          phase: 'collecting',
          operationId: 'remote-health:test',
        },
      },
    });

    render(<RemoteHealthSection />);

    const collectingButton = screen.getByRole('button', { name: 'remoteHealth.collecting' });
    const cancelButton = screen.getByRole('button', { name: 'common.cancel' });
    const sectionActions = collectingButton.closest('[data-slot="remote-health-section-actions"]');

    expect(sectionActions).toBeInTheDocument();
    expect(sectionActions).toContainElement(cancelButton);
    expect(cancelButton.closest('[data-slot="remote-health-actions"]')).toBeNull();

    fireEvent.click(cancelButton);
    expect(cancel).toHaveBeenCalledWith(profile.id);
  });

});
