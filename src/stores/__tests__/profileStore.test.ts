import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProfileStore } from '../profileStore';

const {
  invokeAddProfile,
  invokeUpdateProfile,
  invokeRemoveProfile,
  invokeListProfiles,
  invokeHasExistingData,
  invokeMigrateProfiles,
  invokeRetrieveProfilePassword,
  invokeDeleteProfilePassword,
  invokeStoreProfilePassword,
} = vi.hoisted(() => ({
  invokeAddProfile: vi.fn(),
  invokeUpdateProfile: vi.fn(),
  invokeRemoveProfile: vi.fn(),
  invokeListProfiles: vi.fn().mockResolvedValue([]),
  invokeHasExistingData: vi.fn().mockResolvedValue(true),
  invokeMigrateProfiles: vi.fn().mockResolvedValue(undefined),
  invokeRetrieveProfilePassword: vi.fn().mockResolvedValue(undefined),
  invokeDeleteProfilePassword: vi.fn().mockResolvedValue(undefined),
  invokeStoreProfilePassword: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tauri', () => ({
  invokeAddProfile,
  invokeUpdateProfile,
  invokeRemoveProfile,
  invokeListProfiles,
  invokeHasExistingData,
  invokeMigrateProfiles,
  invokeRetrieveProfilePassword,
  invokeDeleteProfilePassword,
  invokeStoreProfilePassword,
}));

const profileValues = {
  name: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'alice',
  authMethod: 'password' as const,
  password: 'secret',
};

describe('profileStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeAddProfile.mockResolvedValue(undefined);
    invokeUpdateProfile.mockResolvedValue(undefined);
    invokeRemoveProfile.mockResolvedValue(undefined);
    invokeListProfiles.mockResolvedValue([]);
    invokeRetrieveProfilePassword.mockResolvedValue(undefined);
    invokeDeleteProfilePassword.mockResolvedValue(undefined);
    invokeStoreProfilePassword.mockResolvedValue(undefined);
    useProfileStore.setState({ profiles: [], initialized: false });
  });

  it('adds a password profile without persisting the password to legacy storage', async () => {
    const profile = await useProfileStore.getState().addProfile(profileValues);

    expect(invokeAddProfile).toHaveBeenCalledWith(expect.objectContaining({
      id: profile.id,
    }));
    expect(invokeAddProfile).toHaveBeenCalledWith(expect.not.objectContaining({
      password: 'secret',
    }));
    expect(profile.password).toBe('secret');
    expect(useProfileStore.getState().profiles[0].password).toBe('secret');
  });

  it('does not persist a profile when the database insert fails', async () => {
    invokeAddProfile.mockRejectedValue(new Error('database unavailable'));

    await expect(
      useProfileStore.getState().addProfile(profileValues),
    ).rejects.toThrow('database unavailable');

    expect(useProfileStore.getState().profiles).toHaveLength(0);
  });

  it('updates a profile and clears password fields', async () => {
    useProfileStore.setState({
      profiles: [
        {
          ...profileValues,
          password: 'secret',
          id: 'profile-1',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    await useProfileStore.getState().updateProfile('profile-1', {
      authMethod: 'key',
      keychainKeyId: 'key-1',
    });

    expect(useProfileStore.getState().profiles[0]).toMatchObject({
      authMethod: 'key',
      keychainKeyId: 'key-1',
      password: undefined,
    });
    expect(invokeDeleteProfilePassword).toHaveBeenCalledWith('profile-1');
  });

  it('keeps profile state unchanged when a database update fails', async () => {
    useProfileStore.setState({
      profiles: [{
        ...profileValues,
        password: undefined,
        id: 'profile-1',
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    invokeUpdateProfile.mockRejectedValue(new Error('database unavailable'));

    await expect(
      useProfileStore.getState().updateProfile('profile-1', { authMethod: 'key' }),
    ).rejects.toThrow('database unavailable');

    expect(useProfileStore.getState().profiles[0]).toMatchObject({
      authMethod: 'password',
    });
  });

  it('does not rewrite the stored password when it is unchanged', async () => {
    useProfileStore.setState({
      profiles: [{
        ...profileValues,
        password: 'secret',
        keychainKeyId: 'key-1',
        id: 'profile-1',
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    await useProfileStore.getState().updateProfile('profile-1', {
      name: 'Renamed',
      password: 'secret',
    });

    expect(invokeDeleteProfilePassword).not.toHaveBeenCalled();
    expect(invokeStoreProfilePassword).not.toHaveBeenCalled();
    expect(useProfileStore.getState().profiles[0]).toMatchObject({
      name: 'Renamed',
      keychainKeyId: 'key-1',
    });
  });

  it('rewrites the stored password when it changes', async () => {
    useProfileStore.setState({
      profiles: [{
        ...profileValues,
        password: 'secret',
        keychainKeyId: 'key-1',
        id: 'profile-1',
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    await useProfileStore.getState().updateProfile('profile-1', { password: 'new-secret' });

    expect(invokeDeleteProfilePassword).toHaveBeenCalledWith('profile-1');
    expect(invokeStoreProfilePassword).toHaveBeenCalledWith('profile-1', 'new-secret');
    expect(useProfileStore.getState().profiles[0]).toMatchObject({
      password: 'new-secret',
      keychainKeyId: undefined,
    });
  });

  it('persists cleared keychain key references to the database', async () => {
    useProfileStore.setState({
      profiles: [{
        ...profileValues,
        password: undefined,
        keychainKeyId: 'key-1',
        id: 'profile-1',
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    useProfileStore.getState().clearKeychainKeyIds(['profile-1']);

    expect(useProfileStore.getState().profiles[0].keychainKeyId).toBeUndefined();
    expect(invokeUpdateProfile).toHaveBeenCalledWith('profile-1', expect.objectContaining({
      id: 'profile-1',
      keychainKeyId: undefined,
    }));
  });
});
