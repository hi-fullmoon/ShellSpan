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
  invokeStoreProfileSecret,
  invokeRetrieveProfileSecret,
  invokeDeleteProfileSecret,
  invokeDeleteProfileSecrets,
  invokeRemoveRecentProfile,
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
  invokeStoreProfileSecret: vi.fn().mockResolvedValue(undefined),
  invokeRetrieveProfileSecret: vi.fn().mockResolvedValue(undefined),
  invokeDeleteProfileSecret: vi.fn().mockResolvedValue(undefined),
  invokeDeleteProfileSecrets: vi.fn().mockResolvedValue(undefined),
  invokeRemoveRecentProfile: vi.fn().mockResolvedValue(undefined),
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
  invokeStoreProfileSecret,
  invokeRetrieveProfileSecret,
  invokeDeleteProfileSecret,
  invokeDeleteProfileSecrets,
  invokeRemoveRecentProfile,
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
    invokeStoreProfileSecret.mockResolvedValue(undefined);
    invokeRetrieveProfileSecret.mockResolvedValue(undefined);
    invokeDeleteProfileSecret.mockResolvedValue(undefined);
    invokeDeleteProfileSecrets.mockResolvedValue(undefined);
    useProfileStore.setState({ profiles: [], initialized: false });
  });

  it('adds a password profile without persisting the password to profile metadata', async () => {
    const profile = await useProfileStore.getState().addProfile(profileValues);

    expect(invokeAddProfile).toHaveBeenCalledWith(expect.objectContaining({
      id: profile.id,
    }));
    expect(invokeAddProfile).toHaveBeenCalledWith(expect.not.objectContaining({
      password: 'secret',
    }));
    expect(profile.password).toBe('secret');
    expect(useProfileStore.getState().profiles[0].password).toBeUndefined();
  });

  it('persists normalized non-secret connection organization metadata', async () => {
    await useProfileStore.getState().addProfile({
      ...profileValues,
      group: ' Production ',
      tags: [' api ', 'api', 'critical'],
      favorite: true,
      notes: ' Primary service ',
    });

    const row = invokeAddProfile.mock.calls[0][0];
    expect(JSON.parse(row.organizationJson)).toEqual({
      group: 'Production',
      tags: ['api', 'critical'],
      favorite: true,
      notes: 'Primary service',
      portForwards: [],
      quickActions: [],
    });
    expect(row).not.toHaveProperty('password');
  });

  it('persists only validated host quick actions and drops secret-bearing snippets', async () => {
    await useProfileStore.getState().addProfile({
      ...profileValues,
      quickActions: [
        {
          id: 'directory-1',
          kind: 'directory',
          label: 'Releases',
          path: '/srv/releases',
          target: 'sftp',
        },
        {
          id: 'secret-1',
          kind: 'command',
          label: 'Unsafe',
          command: 'password=plaintext',
        },
      ],
    });

    const organization = JSON.parse(invokeAddProfile.mock.calls[0][0].organizationJson);
    expect(organization.quickActions).toEqual([{
      id: 'directory-1',
      kind: 'directory',
      label: 'Releases',
      path: '/srv/releases',
      target: 'sftp',
    }]);
    expect(invokeAddProfile.mock.calls[0][0].organizationJson).not.toContain('plaintext');
  });

  it('does not persist a profile when the database insert fails', async () => {
    invokeAddProfile.mockRejectedValue(new Error('database unavailable'));

    await expect(
      useProfileStore.getState().addProfile(profileValues),
    ).rejects.toThrow('database unavailable');

    expect(useProfileStore.getState().profiles).toHaveLength(0);
  });

  it('rolls back profile metadata when storing its password fails', async () => {
    invokeStoreProfilePassword.mockRejectedValueOnce(new Error('keychain locked'));

    await expect(
      useProfileStore.getState().addProfile(profileValues),
    ).rejects.toThrow('keychain locked');

    const createdId = invokeAddProfile.mock.calls[0][0].id;
    expect(invokeDeleteProfileSecrets).toHaveBeenCalledWith(createdId);
    expect(invokeRemoveProfile).toHaveBeenCalledWith(createdId);
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

  it('drops invalid key references from password profiles', async () => {
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
      keychainKeyId: undefined,
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

    expect(invokeDeleteProfilePassword).not.toHaveBeenCalled();
    expect(invokeStoreProfilePassword).toHaveBeenCalledWith('profile-1', 'new-secret');
    expect(useProfileStore.getState().profiles[0]).toMatchObject({
      password: undefined,
      keychainKeyId: undefined,
    });
  });

  it('rolls back profile metadata when updating its password fails', async () => {
    useProfileStore.setState({
      profiles: [{
        ...profileValues,
        password: undefined,
        id: 'profile-1',
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    invokeRetrieveProfilePassword.mockResolvedValueOnce('old-secret');
    invokeStoreProfilePassword.mockRejectedValueOnce(new Error('keychain locked'));

    await expect(
      useProfileStore.getState().updateProfile('profile-1', { password: 'new-secret' }),
    ).rejects.toThrow('keychain locked');

    expect(invokeUpdateProfile).toHaveBeenCalledTimes(2);
    expect(invokeUpdateProfile.mock.calls[1][1]).toMatchObject({
      id: 'profile-1',
      name: 'Production',
      updatedAt: 1,
    });
    expect(useProfileStore.getState().profiles[0]).toMatchObject({
      updatedAt: 1,
      password: undefined,
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

  it('persists passphrases and jump-host secrets to the keychain on add', async () => {
    const profile = await useProfileStore.getState().addProfile({
      name: 'Jump',
      host: 'internal.example.com',
      port: 22,
      username: 'bob',
      authMethod: 'key',
      keychainKeyId: 'key-1',
      passphrase: 'main-pp',
      jumpHost: {
        host: 'jump.example.com',
        port: 22,
        username: 'jumpuser',
        authMethod: 'password',
        password: 'jump-secret',
      },
    });

    expect(invokeStoreProfileSecret).toHaveBeenCalledWith(profile.id, 'passphrase', 'main-pp');
    expect(invokeStoreProfileSecret).toHaveBeenCalledWith(profile.id, 'jump-password', 'jump-secret');

    // Secrets must never land in the database row.
    const row = invokeAddProfile.mock.calls[0][0];
    const parsedJumpHost = JSON.parse(row.jumpHostConfig);
    expect(parsedJumpHost.password).toBeUndefined();
    expect(parsedJumpHost.passphrase).toBeUndefined();
  });

  it('syncs secrets on update: stores changed values and deletes cleared ones', async () => {
    useProfileStore.setState({
      profiles: [{
        name: 'Key',
        host: 'h',
        port: 22,
        username: 'u',
        authMethod: 'key' as const,
        keychainKeyId: 'key-1',
        passphrase: 'old-pp',
        jumpHost: {
          host: 'j',
          port: 22,
          username: 'ju',
          authMethod: 'password' as const,
          password: 'old-jump',
        },
        id: 'profile-1',
        createdAt: 1,
        updatedAt: 1,
      }],
    });

    await useProfileStore.getState().updateProfile('profile-1', {
      passphrase: 'new-pp',
      jumpHost: {
        host: 'j',
        port: 22,
        username: 'ju',
        authMethod: 'key',
        keychainKeyId: 'key-2',
        passphrase: 'jump-pp',
      },
    });

    expect(invokeStoreProfileSecret).toHaveBeenCalledWith('profile-1', 'passphrase', 'new-pp');
    expect(invokeDeleteProfileSecret).toHaveBeenCalledWith('profile-1', 'jump-password');
    expect(invokeStoreProfileSecret).toHaveBeenCalledWith('profile-1', 'jump-passphrase', 'jump-pp');
  });

  it('deletes all profile secrets on remove', async () => {
    useProfileStore.setState({
      profiles: [{ ...profileValues, id: 'profile-1', createdAt: 1, updatedAt: 1 }],
    });

    await useProfileStore.getState().removeProfile('profile-1');

    expect(invokeDeleteProfileSecrets).toHaveBeenCalledWith('profile-1');
  });

  it('rolls back a duplicate when copying its credentials fails', async () => {
    useProfileStore.setState({
      profiles: [{ ...profileValues, password: undefined, id: 'profile-1', createdAt: 1, updatedAt: 1 }],
    });
    invokeRetrieveProfilePassword.mockResolvedValueOnce('secret');
    invokeStoreProfilePassword.mockRejectedValueOnce(new Error('keychain locked'));

    await expect(useProfileStore.getState().duplicateProfile('profile-1')).rejects.toThrow(
      'keychain locked',
    );

    const duplicateId = invokeAddProfile.mock.calls[0][0].id;
    expect(invokeDeleteProfileSecrets).toHaveBeenCalledWith(duplicateId);
    expect(invokeRemoveProfile).toHaveBeenCalledWith(duplicateId);
    expect(useProfileStore.getState().profiles).toHaveLength(1);
  });

  it('keeps a profile when its native secrets cannot be deleted', async () => {
    useProfileStore.setState({
      profiles: [{ ...profileValues, id: 'profile-1', createdAt: 1, updatedAt: 1 }],
    });
    invokeDeleteProfileSecrets.mockRejectedValue(new Error('keychain locked'));

    await expect(useProfileStore.getState().removeProfile('profile-1')).rejects.toThrow(
      'keychain locked',
    );

    expect(invokeRemoveProfile).not.toHaveBeenCalled();
    expect(useProfileStore.getState().getProfile('profile-1')).toBeDefined();
  });

  it('hydrates profile metadata without reading keychain secrets', async () => {
    invokeListProfiles.mockResolvedValue([{
      id: 'profile-1',
      name: 'Key',
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'key',
      keychainKeyId: 'key-1',
      jumpHostConfig: JSON.stringify({
        host: 'j',
        port: 22,
        username: 'ju',
        authMethod: 'password',
      }),
      organizationJson: JSON.stringify({
        group: 'Production',
        tags: ['api', 'critical'],
        favorite: true,
        notes: 'Primary service',
        portForwards: [{
          id: 'forward-1',
          name: 'Database',
          kind: 'local',
          localPort: 15432,
          remoteHost: '127.0.0.1',
          remotePort: 5432,
          autoStart: true,
        }],
        quickActions: [{
          id: 'command-1',
          kind: 'command',
          label: 'Check status',
          command: 'systemctl status api',
        }],
      }),
      createdAt: 1,
      updatedAt: 1,
    }]);

    await useProfileStore.getState().hydrateFromDb();

    const profile = useProfileStore.getState().profiles[0];
    expect(profile.passphrase).toBeUndefined();
    expect(profile.jumpHost?.password).toBeUndefined();
    expect(profile).toMatchObject({
      group: 'Production',
      tags: ['api', 'critical'],
      favorite: true,
      notes: 'Primary service',
      portForwards: [expect.objectContaining({
        id: 'forward-1',
        autoStart: true,
      })],
      quickActions: [expect.objectContaining({
        id: 'command-1',
        command: 'systemctl status api',
      })],
    });
    expect(invokeRetrieveProfilePassword).not.toHaveBeenCalled();
    expect(invokeRetrieveProfileSecret).not.toHaveBeenCalled();
  });

  it('loads stored profile secrets on demand without caching them in global state', async () => {
    useProfileStore.setState({
      profiles: [{
        id: 'profile-1',
        name: 'Key',
        host: 'h',
        port: 22,
        username: 'u',
        authMethod: 'key',
        keychainKeyId: 'key-1',
        jumpHost: {
          host: 'j',
          port: 22,
          username: 'ju',
          authMethod: 'password',
        },
        createdAt: 1,
        updatedAt: 1,
      }],
    });
    invokeRetrieveProfileSecret.mockImplementation((_id: string, kind: string) => {
      if (kind === 'passphrase') return Promise.resolve('main-pp');
      if (kind === 'jump-password') return Promise.resolve('jump-secret');
      return Promise.resolve(undefined);
    });

    const profile = await useProfileStore
      .getState()
      .ensurePassword(useProfileStore.getState().profiles[0]);

    expect(profile.passphrase).toBe('main-pp');
    expect(profile.jumpHost?.password).toBe('jump-secret');
    expect(useProfileStore.getState().profiles[0].passphrase).toBeUndefined();
    expect(useProfileStore.getState().profiles[0].jumpHost?.password).toBeUndefined();
  });

  it('discards unexpected plaintext secrets from database rows', async () => {
    invokeListProfiles.mockResolvedValue([{
      id: 'profile-1',
      name: 'Jump',
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'password',
      jumpHostConfig: JSON.stringify({
        host: 'j',
        port: 22,
        username: 'ju',
        authMethod: 'password',
        password: 'unexpected-plaintext',
        passphrase: 'unexpected-passphrase',
        privateKeyData: 'unexpected-private-key',
      }),
      createdAt: 1,
      updatedAt: 1,
    }]);

    await useProfileStore.getState().hydrateFromDb();

    const jumpHost = useProfileStore.getState().profiles[0].jumpHost;
    expect(jumpHost?.password).toBeUndefined();
    expect(jumpHost?.passphrase).toBeUndefined();
    expect(jumpHost?.privateKeyData).toBeUndefined();
    expect(invokeStoreProfileSecret).not.toHaveBeenCalled();
  });

});
