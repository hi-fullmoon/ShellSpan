import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureKeychainKeyForProfile,
  preparePasswordKeychain,
  promptForMissingKeychainKey,
} from '../keychain-key-prompt';
import { useKeychainStore } from '@/stores/keychainStore';
import { useProfileStore } from '@/stores/profileStore';
import { usePasswordPromptStore } from '@/stores/passwordPromptStore';
import { useKeychainKeyPromptStore } from '@/stores/keychainKeyPromptStore';
import { invokeUpdateProfile } from '@/lib/tauri';
import type { ConnectionProfile } from '@/types';

vi.mock('@/lib/tauri', () => ({
  invokeStoreProfilePassword: vi.fn().mockResolvedValue(undefined),
  invokeUpdateProfile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/locales', () => ({
  t: (key: string) => key,
  changeLocale: vi.fn(),
  initI18n: vi.fn(),
}));

const profile: ConnectionProfile = {
  id: 'p1',
  name: 'Server',
  host: 'h',
  port: 22,
  username: 'u',
  authMethod: 'password',
  keychainKeyId: 'missing-key',
  createdAt: 0,
  updatedAt: 0,
};

const initialKeychain = useKeychainStore.getState();
const initialProfiles = useProfileStore.getState();
const initialPasswordPrompt = usePasswordPromptStore.getState();
const initialKeychainKeyPrompt = useKeychainKeyPromptStore.getState();

describe('preparePasswordKeychain', () => {
  beforeEach(() => {
    useKeychainStore.setState(initialKeychain, true);
    useProfileStore.setState(initialProfiles, true);
    usePasswordPromptStore.setState(initialPasswordPrompt, true);
    useKeychainKeyPromptStore.setState(initialKeychainKeyPrompt, true);
    useKeychainStore.setState({ initialized: true });
    useProfileStore.setState({ profiles: [profile] });
    vi.mocked(invokeUpdateProfile).mockClear();
  });

  it('returns the profile unchanged when it does not reference a keychain', async () => {
    const plain: ConnectionProfile = { ...profile, keychainKeyId: undefined };
    await expect(preparePasswordKeychain(plain)).resolves.toBe(plain);
  });

  it('loads the password from an existing keychain entry', async () => {
    useKeychainStore.setState({
      getKey: vi.fn().mockResolvedValue({
        id: 'missing-key',
        label: 'Server password',
        kind: 'password',
        privateKey: 'stored-secret',
      }),
    });

    const result = await preparePasswordKeychain(profile);

    expect(result).toMatchObject({ password: 'stored-secret', keychainKeyId: 'missing-key' });
  });

  it('falls back to the profile password and clears the dangling reference when the keychain entry is missing', async () => {
    useKeychainStore.setState({ getKey: vi.fn().mockResolvedValue(undefined) });
    const withPassword: ConnectionProfile = { ...profile, password: 'inline-secret' };

    const result = await preparePasswordKeychain(withPassword);

    expect(result).toMatchObject({ password: 'inline-secret', keychainKeyId: undefined });
    expect(useProfileStore.getState().getProfile('p1')?.keychainKeyId).toBeUndefined();
    expect(invokeUpdateProfile).toHaveBeenCalledWith('p1', expect.objectContaining({
      keychainKeyId: undefined,
    }));
  });

  it('clears the dangling reference and prompts when neither entry nor password exists', async () => {
    useKeychainStore.setState({ getKey: vi.fn().mockResolvedValue(undefined) });

    const pending = preparePasswordKeychain(profile);
    await vi.waitFor(() => {
      expect(usePasswordPromptStore.getState().pending).not.toBeNull();
    });
    usePasswordPromptStore.getState().resolvePassword({ password: 'entered-secret' });

    const result = await pending;

    expect(result).toMatchObject({ password: 'entered-secret', keychainKeyId: undefined });
    expect(useProfileStore.getState().getProfile('p1')?.keychainKeyId).toBeUndefined();
    expect(invokeUpdateProfile).toHaveBeenCalledWith('p1', expect.objectContaining({
      keychainKeyId: undefined,
    }));
  });

  it('returns null when the prompt is cancelled after clearing the reference', async () => {
    useKeychainStore.setState({ getKey: vi.fn().mockResolvedValue(undefined) });

    const pending = preparePasswordKeychain(profile);
    await vi.waitFor(() => {
      expect(usePasswordPromptStore.getState().pending).not.toBeNull();
    });
    usePasswordPromptStore.getState().resolvePassword(null);

    await expect(pending).resolves.toBeNull();
    expect(useProfileStore.getState().getProfile('p1')?.keychainKeyId).toBeUndefined();
  });
});

describe('keychain key prompt recovery', () => {
  const jumpProfile: ConnectionProfile = {
    ...profile,
    authMethod: 'password',
    keychainKeyId: undefined,
    password: 'main-password',
    jumpHost: {
      host: 'jump',
      port: 22,
      username: 'ju',
      authMethod: 'key',
      keychainKeyId: 'missing-jump-key',
    },
  };

  beforeEach(() => {
    useKeychainStore.setState(initialKeychain, true);
    useProfileStore.setState(initialProfiles, true);
    usePasswordPromptStore.setState(initialPasswordPrompt, true);
    useKeychainKeyPromptStore.setState(initialKeychainKeyPrompt, true);
    useKeychainStore.setState({
      initialized: true,
      keys: [{ id: 'new-jump-key', label: 'Jump Key', keyType: 'ed25519', kind: 'keyFile' }],
    });
    useProfileStore.setState({ profiles: [jumpProfile] });
    vi.mocked(invokeUpdateProfile).mockClear();
  });

  it('updates the jump-host keychain key when the jump key is recovered', async () => {
    const pending = promptForMissingKeychainKey(jumpProfile, 'jump');
    await vi.waitFor(() => {
      expect(useKeychainKeyPromptStore.getState().pending?.request).toMatchObject({
        host: 'jump',
        username: 'ju',
      });
    });

    useKeychainKeyPromptStore.getState().resolveKey({
      kind: 'key',
      keyId: 'new-jump-key',
    });

    const result = await pending;

    expect(result?.jumpHost?.keychainKeyId).toBe('new-jump-key');
    expect(useProfileStore.getState().getProfile('p1')?.jumpHost?.keychainKeyId)
      .toBe('new-jump-key');
    expect(invokeUpdateProfile).toHaveBeenCalledWith('p1', expect.objectContaining({
      jumpHostConfig: expect.stringContaining('new-jump-key'),
    }));
  });

  it('checks and recovers jump-host keys even when the target uses password auth', async () => {
    const pending = ensureKeychainKeyForProfile({
      ...jumpProfile,
      jumpHost: {
        ...jumpProfile.jumpHost!,
        keychainKeyId: 'missing-jump-key',
      },
    });
    await vi.waitFor(() => {
      expect(useKeychainKeyPromptStore.getState().pending?.request).toMatchObject({
        host: 'jump',
        username: 'ju',
      });
    });

    useKeychainKeyPromptStore.getState().resolveKey({
      kind: 'key',
      keyId: 'new-jump-key',
    });

    const result = await pending;

    expect(result?.jumpHost?.keychainKeyId).toBe('new-jump-key');
  });
});
