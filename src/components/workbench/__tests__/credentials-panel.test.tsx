import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '@/types';
import { useProfileStore } from '@/stores/profileStore';
import { CredentialsPanel } from '../credentials-panel';

const {
  invokeListCachedCredentialProfileIds,
  invokeClearCredentialCache,
  invokeRemovePassword,
  invokeRetrievePassword,
} = vi.hoisted(() => ({
  invokeListCachedCredentialProfileIds: vi.fn(),
  invokeClearCredentialCache: vi.fn(),
  invokeRemovePassword: vi.fn(),
  invokeRetrievePassword: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  invokeListCachedCredentialProfileIds,
  invokeClearCredentialCache,
  invokeRemovePassword,
  invokeRetrievePassword,
  invokeStorePassword: vi.fn(),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

const savedProfile: ConnectionProfile = {
  id: 'profile-1',
  name: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'alice',
  authMethod: 'password',
  passwordStored: true,
  createdAt: 1,
  updatedAt: 1,
};

const unsavedProfile: ConnectionProfile = {
  ...savedProfile,
  id: 'profile-2',
  name: 'Staging',
  host: 'staging.example.com',
  passwordStored: false,
};

const initialProfileState = useProfileStore.getState();

describe('CredentialsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeListCachedCredentialProfileIds.mockResolvedValue(['profile-1']);
    invokeClearCredentialCache.mockResolvedValue(undefined);
    invokeRemovePassword.mockResolvedValue(undefined);
    invokeRetrievePassword.mockResolvedValue('super-secret');
    useProfileStore.setState(initialProfileState, true);
    useProfileStore.setState({ profiles: [savedProfile, unsavedProfile] });
  });

  it('lists saved credential metadata', async () => {
    render(<CredentialsPanel />);

    expect(await screen.findByText('Production')).toBeInTheDocument();
    expect(screen.getByText('alice@prod.example.com:22')).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'workbench.credentials.clearCache',
      }),
    ).toBeEnabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { pressed: false })).toBeInTheDocument();
    expect(screen.queryByText('Staging')).not.toBeInTheDocument();
    expect(invokeListCachedCredentialProfileIds).toHaveBeenCalledTimes(1);
  });

  it('clears only the in-memory cache status', async () => {
    render(<CredentialsPanel />);
    const clearButton = await screen.findByRole('button', {
      name: 'workbench.credentials.clearCache',
    });
    await waitFor(() => expect(clearButton).toBeEnabled());

    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(invokeClearCredentialCache).toHaveBeenCalledTimes(1);
    });
    expect(clearButton).toBeDisabled();
    expect(screen.getByText('Production')).toBeInTheDocument();
  });

  it('ignores a stale refresh result after clearing the cache', async () => {
    let resolveRefresh!: (profileIds: string[]) => void;
    const refreshResult = new Promise<string[]>((resolve) => {
      resolveRefresh = resolve;
    });

    render(<CredentialsPanel />);
    const clearButton = await screen.findByRole('button', {
      name: 'workbench.credentials.clearCache',
    });
    await waitFor(() => expect(clearButton).toBeEnabled());
    invokeListCachedCredentialProfileIds.mockReturnValueOnce(refreshResult);

    fireEvent.click(screen.getByRole('button', { name: 'common.refresh' }));
    fireEvent.click(
      screen.getByRole('button', {
        name: 'workbench.credentials.clearCache',
      }),
    );

    await waitFor(() => {
      expect(invokeClearCredentialCache).toHaveBeenCalledTimes(1);
    });
    resolveRefresh(['profile-1']);

    await waitFor(() => {
      expect(clearButton).toBeDisabled();
    });
  });

  it('deletes the keychain item while retaining the connection profile', async () => {
    render(<CredentialsPanel />);
    await screen.findByText('Production');

    fireEvent.click(screen.getByLabelText('common.delete'));
    const dialog = screen.getByRole('alertdialog');
    const deleteButton = screen.getByRole('button', { name: 'common.delete' });
    expect(dialog).toHaveClass('gap-0', 'overflow-hidden', 'p-0');
    expect(dialog).toHaveClass(
      'data-open:animate-[dialog-fade-in_150ms_ease-out]',
      'data-closed:animate-[dialog-fade-out_150ms_ease-in]',
    );
    expect(dialog).not.toHaveClass('data-open:animate-in', 'data-closed:animate-out');
    expect(deleteButton).toHaveClass('bg-destructive', 'h-8');
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(invokeRemovePassword).toHaveBeenCalledWith('profile-1');
    });
    expect(
      useProfileStore.getState().profiles.find((profile) => profile.id === 'profile-1'),
    ).toMatchObject({ passwordStored: false });
    expect(useProfileStore.getState().profiles).toHaveLength(2);
  });

  it('reveals the password only after retrieving it from the keychain', async () => {
    invokeListCachedCredentialProfileIds.mockResolvedValue([]);
    render(<CredentialsPanel />);
    await screen.findByText('Production');
    const clearButton = screen.getByRole('button', {
      name: 'workbench.credentials.clearCache',
    });
    expect(clearButton).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { pressed: false }));
    const details = screen.getByRole('dialog');
    expect(
      within(details).getByRole('heading', { name: 'Production' }),
    ).toBeInTheDocument();
    expect(
      within(details).getByText('alice@prod.example.com:22'),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'workbench.credentials.showPassword',
      }),
    );

    expect(await screen.findByText('super-secret')).toBeInTheDocument();
    expect(invokeRetrievePassword).toHaveBeenCalledWith('profile-1');
    expect(
      screen.getByRole('button', {
        name: 'workbench.credentials.hidePassword',
      }),
    ).toBeInTheDocument();
    expect(clearButton).toBeEnabled();
  });

});
