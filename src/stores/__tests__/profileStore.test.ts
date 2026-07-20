import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProfileStore } from '../profileStore';

const {
  invokeRemovePassword,
  invokeRetrievePassword,
  invokeStorePassword,
} = vi.hoisted(() => ({
  invokeRemovePassword: vi.fn(),
  invokeRetrievePassword: vi.fn(),
  invokeStorePassword: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  invokeRemovePassword,
  invokeRetrievePassword,
  invokeStorePassword,
}));

const profileValues = {
  name: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'alice',
  authMethod: 'password' as const,
  password: 'secret',
};

describe('profileStore keychain lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeStorePassword.mockResolvedValue(undefined);
    invokeRemovePassword.mockResolvedValue(undefined);
    invokeRetrievePassword.mockResolvedValue(null);
    useProfileStore.setState({ profiles: [] });
  });

  it('stores the secret before persisting only credential metadata', async () => {
    const profile = await useProfileStore.getState().addProfile(profileValues);

    expect(invokeStorePassword).toHaveBeenCalledWith(profile.id, 'secret');
    expect(profile).toMatchObject({ passwordStored: true });
    expect(profile.password).toBeUndefined();
    expect(useProfileStore.getState().profiles[0].password).toBeUndefined();
  });

  it('does not persist a profile when secure storage fails', async () => {
    invokeStorePassword.mockRejectedValue(new Error('keychain unavailable'));

    await expect(
      useProfileStore.getState().addProfile(profileValues),
    ).rejects.toThrow('keychain unavailable');
    expect(useProfileStore.getState().profiles).toHaveLength(0);
  });

  it('removes an obsolete password when authentication changes to key', async () => {
    useProfileStore.setState({
      profiles: [
        {
          ...profileValues,
          password: undefined,
          passwordStored: true,
          id: 'profile-1',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    await useProfileStore.getState().updateProfile('profile-1', {
      authMethod: 'key',
      privateKeyPath: '/keys/id_ed25519',
    });

    expect(invokeRemovePassword).toHaveBeenCalledWith('profile-1');
    expect(useProfileStore.getState().profiles[0]).toMatchObject({
      authMethod: 'key',
      passwordStored: false,
    });
  });
});
