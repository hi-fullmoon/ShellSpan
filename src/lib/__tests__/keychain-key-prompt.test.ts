import { beforeEach, describe, expect, it, vi } from 'vitest';
import { preparePasswordKeychain } from '../keychain-key-prompt';
import { useKeychainStore } from '@/stores/keychainStore';
import { useProfileStore } from '@/stores/profileStore';
import { usePasswordPromptStore } from '@/stores/passwordPromptStore';
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

describe('preparePasswordKeychain', () => {
  beforeEach(() => {
    useKeychainStore.setState(initialKeychain, true);
    useProfileStore.setState(initialProfiles, true);
    usePasswordPromptStore.setState(initialPasswordPrompt, true);
    useKeychainStore.setState({ initialized: true });
    useProfileStore.setState({ profiles: [profile] });
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
