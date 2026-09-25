import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

    expect(screen.getByText('remoteHealth.title').querySelector('svg')).toBeNull();
    expect(screen.getByText('remoteHealth.title').closest('[data-slot="card"]'))
      .toHaveAttribute('data-radius', 'compact');
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
        commandSetVersion: 'shellspan-read-only-v1',
        profileId: profile.id,
        host: profile.host,
        port: profile.port,
        username: profile.username,
      },
    };
    let resolveCollection: (value: RemoteHealthSnapshotResult) => void = () => {};
    const collect = vi.fn(() => new Promise<RemoteHealthSnapshotResult>((resolve) => {
      resolveCollection = resolve;
    }));
    useRemoteHealthStore.setState({ collect });
    render(<RemoteHealthSection />);

    const collectButton = screen.getByRole('button', { name: 'remoteHealth.collect' });
    expect(collectButton).toHaveClass('h-8');
    expect(collectButton.closest('[data-slot="card-footer"]')).toBeNull();
    expect(collectButton.closest('[data-slot="card-action"]')).toBeInTheDocument();
    expect(collectButton.closest('[data-slot="remote-health-section-actions"]'))
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
    const pendingConfirm = within(dialog).getByRole('button', {
      name: 'remoteHealth.preparing',
    });
    expect(pendingConfirm).toBeDisabled();
    expect(pendingConfirm).toHaveAttribute('aria-busy', 'true');
    expect(pendingConfirm.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'common.cancel' })).toBeDisabled();

    act(() => useRemoteHealthStore.setState({
      entries: {
        [profile.id]: {
          profileId: profile.id,
          phase: 'collecting',
          operationId: 'remote-health:test',
        },
      },
    }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeEnabled();

    await act(async () => resolveCollection(result));
  });

  it('uses the single collection control to cancel while collecting', () => {
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

    const cancelButton = screen.getByRole('button', { name: 'common.cancel' });
    const sectionActions = cancelButton.closest<HTMLElement>(
      '[data-slot="remote-health-section-actions"]',
    );
    const collectionActions = cancelButton.closest<HTMLElement>(
      '[data-slot="remote-health-collection-actions"]',
    );

    expect(sectionActions).toBeInTheDocument();
    expect(collectionActions).toBeInTheDocument();
    expect(collectionActions).toHaveClass('flex', 'shrink-0', 'flex-nowrap');
    expect(collectionActions).toContainElement(cancelButton);
    expect(collectionActions?.querySelectorAll('button')).toHaveLength(1);
    expect(cancelButton).toBeEnabled();
    expect(cancelButton).toHaveClass('h-8');
    expect(cancelButton.querySelector('[data-slot="spinner"]')).toBeInTheDocument();
    expect(sectionActions).toContainElement(collectionActions);
    expect(cancelButton.closest('[data-slot="remote-health-actions"]')).toBeNull();

    fireEvent.click(cancelButton);
    expect(cancel).toHaveBeenCalledWith(profile.id);

    act(() => useRemoteHealthStore.setState({
      entries: {
        [profile.id]: {
          profileId: profile.id,
          phase: 'cancelling',
          operationId: 'remote-health:test',
        },
      },
    }));
    expect(screen.getByRole('button', { name: 'remoteHealth.cancelling' })).toBe(cancelButton);
    expect(cancelButton).toBeDisabled();
    expect(collectionActions?.querySelectorAll('button')).toHaveLength(1);
  });

});
