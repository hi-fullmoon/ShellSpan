import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProfileStore } from '../profileStore';

const {
  invokeRemovePassword,
  invokeRetrievePassword,
  invokeStorePassword,
  invokeAddProfile,
  invokeUpdateProfile,
  invokeRemoveProfile,
  invokeListProfiles,
  invokeHasExistingData,
  invokeMigrateProfiles,
} = vi.hoisted(() => ({
  invokeRemovePassword: vi.fn(),
  invokeRetrievePassword: vi.fn(),
  invokeStorePassword: vi.fn(),
  invokeAddProfile: vi.fn(),
  invokeUpdateProfile: vi.fn(),
  invokeRemoveProfile: vi.fn(),
  invokeListProfiles: vi.fn().mockResolvedValue([]),
  invokeHasExistingData: vi.fn().mockResolvedValue(true),
  invokeMigrateProfiles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tauri', () => ({
  invokeRemovePassword,
  invokeRetrievePassword,
  invokeStorePassword,
  invokeAddProfile,
  invokeUpdateProfile,
  invokeRemoveProfile,
  invokeListProfiles,
  invokeHasExistingData,
  invokeMigrateProfiles,
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
    invokeAddProfile.mockResolvedValue(undefined);
    invokeUpdateProfile.mockResolvedValue(undefined);
    invokeRemoveProfile.mockResolvedValue(undefined);
    invokeListProfiles.mockResolvedValue([]);
    useProfileStore.setState({ profiles: [], initialized: false });
  });

  it('stores the secret before persisting only credential metadata', async () => {
    const profile = await useProfileStore.getState().addProfile(profileValues);

    expect(invokeStorePassword).toHaveBeenCalledWith(profile.id, 'secret');
    expect(invokeAddProfile).toHaveBeenCalledWith(expect.objectContaining({
      id: profile.id,
      passwordStored: true,
    }));
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

  it('does not expose a profile when the database insert fails', async () => {
    invokeAddProfile.mockRejectedValue(new Error('database unavailable'));

    await expect(
      useProfileStore.getState().addProfile(profileValues),
    ).rejects.toThrow('database unavailable');

    expect(useProfileStore.getState().profiles).toHaveLength(0);
    expect(invokeRemovePassword).toHaveBeenCalledTimes(1);
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
      authMethod: 'keyPath',
      privateKeyPath: '/keys/id_ed25519',
    });

    expect(invokeRemovePassword).toHaveBeenCalledWith('profile-1');
    expect(useProfileStore.getState().profiles[0]).toMatchObject({
      authMethod: 'keyPath',
      passwordStored: false,
    });
  });

  it('keeps profile and keychain state unchanged when a database update fails', async () => {
    useProfileStore.setState({
      profiles: [{
        ...profileValues,
        password: undefined,
        passwordStored: true,
        id: 'profile-1',
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    invokeUpdateProfile.mockRejectedValue(new Error('database unavailable'));

    await expect(
      useProfileStore.getState().updateProfile('profile-1', { authMethod: 'keyPath' }),
    ).rejects.toThrow('database unavailable');

    expect(invokeRemovePassword).not.toHaveBeenCalled();
    expect(useProfileStore.getState().profiles[0]).toMatchObject({
      authMethod: 'password',
      passwordStored: true,
    });
  });

  it('persists passwordStored=false when removing a stored password', async () => {
    useProfileStore.setState({
      profiles: [{
        ...profileValues,
        password: undefined,
        passwordStored: true,
        id: 'profile-1',
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    await useProfileStore.getState().removeStoredPassword('profile-1');

    expect(invokeUpdateProfile).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ passwordStored: false }),
    );
    expect(invokeRemovePassword).toHaveBeenCalledWith('profile-1');
    expect(useProfileStore.getState().profiles[0].passwordStored).toBe(false);
  });
});
