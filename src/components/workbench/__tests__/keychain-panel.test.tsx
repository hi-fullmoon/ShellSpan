import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { KeychainPanel } from '../keychain-panel';
import { useKeychainStore } from '@/stores/keychainStore';
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
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('KeychainPanel', () => {
  const initialKeychain = useKeychainStore.getState();
  const initialProfiles = useProfileStore.getState();

  beforeEach(() => {
    useKeychainStore.setState(initialKeychain, true);
    useProfileStore.setState(initialProfiles, true);
    useKeychainStore.setState({
      keys: [
        { id: 'profile-1', label: 'Server password', keyType: 'profile', kind: 'password', service: 'com.termbridge.profile-password' },
        { id: 'key-1', label: 'Server key', keyType: 'rsa', kind: 'keyFile', service: 'com.termbridge.key' },
      ],
      initialized: true,
    });
  });

  it('renders profile password keychains without an edit button', () => {
    render(<KeychainPanel />);

    expect(screen.getByText('Server password')).toBeInTheDocument();
    const editButtons = screen.queryAllByRole('button', {
      name: 'common.edit',
      hidden: true,
    });
    expect(editButtons).toHaveLength(1);
  });

  it('renders regular key keychains with an edit button', () => {
    render(<KeychainPanel />);

    expect(screen.getByText('Server key')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'common.edit', hidden: true }),
    ).toBeInTheDocument();
  });

  it('renders delete buttons for all keychains', () => {
    render(<KeychainPanel />);

    const deleteButtons = screen.getAllByRole('button', {
      name: 'common.delete',
      hidden: true,
    });
    expect(deleteButtons).toHaveLength(2);
  });

  it('creates key-file keys only and hides the kind selector', () => {
    render(<KeychainPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'common.create' }));

    expect(
      screen.getByPlaceholderText('keychain.form.privateKeyPlaceholder'),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('keychain.form.publicKeyOptionalPlaceholder'),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('keychain.form.passwordPlaceholder'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText('workbench.keychain.newSubtitle'),
    ).toBeInTheDocument();
  });

  it('clears dangling keychain references on profiles after deleting a key', async () => {
    const removeKey = vi.fn().mockResolvedValue(['p1', 'p2']);
    useKeychainStore.setState({ removeKey });

    const makeProfile = (id: string, keychainKeyId?: string): ConnectionProfile => ({
      id,
      name: id,
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'key',
      keychainKeyId,
      createdAt: 0,
      updatedAt: 0,
    });
    useProfileStore.setState({
      profiles: [
        makeProfile('p1', 'key-1'),
        {
          ...makeProfile('p2'),
          jumpHost: {
            host: 'jump',
            port: 22,
            username: 'jump',
            authMethod: 'key',
            keychainKeyId: 'key-1',
          },
        },
        makeProfile('p3', 'other-key'),
      ],
    });

    render(<KeychainPanel />);

    const deleteButtons = screen.getAllByRole('button', {
      name: 'common.delete',
      hidden: true,
    });
    fireEvent.click(deleteButtons[1]);

    const confirmButton = await screen.findByRole('button', { name: 'common.delete' });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(useProfileStore.getState().getProfile('p1')?.keychainKeyId).toBeUndefined();
    });
    expect(removeKey).toHaveBeenCalledWith('key-1');
    expect(useProfileStore.getState().getProfile('p2')?.jumpHost?.keychainKeyId).toBeUndefined();
    expect(useProfileStore.getState().getProfile('p3')?.keychainKeyId).toBe('other-key');
  });

  it('clears an in-memory profile password after deleting its credential', async () => {
    const removeKey = vi.fn().mockResolvedValue([]);
    useKeychainStore.setState({ removeKey });
    useProfileStore.setState({
      profiles: [{
        id: 'profile-1',
        name: 'Server',
        host: 'h',
        port: 22,
        username: 'u',
        authMethod: 'password',
        password: 'secret',
        createdAt: 0,
        updatedAt: 0,
      }],
    });

    render(<KeychainPanel />);
    const deleteButtons = screen.getAllByRole('button', {
      name: 'common.delete',
      hidden: true,
    });
    fireEvent.click(deleteButtons[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'common.delete' }));

    await waitFor(() => {
      expect(useProfileStore.getState().getProfile('profile-1')?.password).toBeUndefined();
    });
    expect(removeKey).toHaveBeenCalledWith('profile-1');
  });
});
