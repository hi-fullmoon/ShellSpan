import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '@/types';
import { useProfileStore } from '@/stores/profileStore';
import { CredentialsPanel } from '../credentials-panel';

const {
  invokeListCachedCredentialProfileIds,
  invokeClearCredentialCache,
  invokeRemovePassword,
} = vi.hoisted(() => ({
  invokeListCachedCredentialProfileIds: vi.fn(),
  invokeClearCredentialCache: vi.fn(),
  invokeRemovePassword: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  invokeListCachedCredentialProfileIds,
  invokeClearCredentialCache,
  invokeRemovePassword,
  invokeRetrievePassword: vi.fn(),
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
    useProfileStore.setState(initialProfileState, true);
    useProfileStore.setState({ profiles: [savedProfile, unsavedProfile] });
  });

  it('lists saved credential metadata and its cache status', async () => {
    render(<CredentialsPanel onEdit={vi.fn()} />);

    expect(await screen.findByText('Production')).toBeInTheDocument();
    expect(screen.getByText('alice@prod.example.com:22')).toBeInTheDocument();
    expect(screen.getByText('workbench.credentials.cached')).toBeInTheDocument();
    expect(screen.queryByText('Staging')).not.toBeInTheDocument();
    expect(invokeListCachedCredentialProfileIds).toHaveBeenCalledTimes(1);
  });

  it('clears only the in-memory cache status', async () => {
    render(<CredentialsPanel onEdit={vi.fn()} />);
    await screen.findByText('workbench.credentials.cached');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'workbench.credentials.clearCache',
      }),
    );

    await waitFor(() => {
      expect(invokeClearCredentialCache).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText('workbench.credentials.stored')).toBeInTheDocument();
    expect(screen.getByText('Production')).toBeInTheDocument();
  });

  it('deletes the keychain item while retaining the connection profile', async () => {
    render(<CredentialsPanel onEdit={vi.fn()} />);
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

  it('opens the connection editor for credential replacement', async () => {
    const onEdit = vi.fn();
    render(<CredentialsPanel onEdit={onEdit} />);
    await screen.findByText('Production');

    fireEvent.click(screen.getByLabelText('common.edit'));

    expect(onEdit).toHaveBeenCalledWith(savedProfile);
  });
});
