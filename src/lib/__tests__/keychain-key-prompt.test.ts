import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureKeychainKeyForProfile,
  promptForMissingKeychainKey,
} from '../keychain-key-prompt';
import { useKeychainStore } from '@/stores/keychainStore';
import { useProfileStore } from '@/stores/profileStore';
import { useKeychainKeyPromptStore } from '@/stores/keychainKeyPromptStore';
import { invokeListKeyCredentials, invokeUpdateProfile } from '@/lib/tauri';
import type { ConnectionProfile } from '@/types';

vi.mock('@/lib/tauri', () => ({
  invokeListKeyCredentials: vi.fn().mockResolvedValue([]),
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
const initialKeychainKeyPrompt = useKeychainKeyPromptStore.getState();

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
    useKeychainKeyPromptStore.setState(initialKeychainKeyPrompt, true);
    useKeychainStore.setState({
      initialized: true,
      keys: [{ id: 'new-jump-key', label: 'Jump Key', keyType: 'ed25519', kind: 'keyFile', service: 'com.termbridge.key' }],
    });
    useProfileStore.setState({ profiles: [jumpProfile] });
    vi.mocked(invokeUpdateProfile).mockClear();
    vi.mocked(invokeListKeyCredentials).mockReset();
    vi.mocked(invokeListKeyCredentials).mockResolvedValue([]);
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

  it('does not prompt for replacement keys when key metadata failed to load', async () => {
    useKeychainStore.setState({
      initialized: false,
      keys: [],
      loadError: undefined,
    });
    vi.mocked(invokeListKeyCredentials).mockRejectedValueOnce(new Error('database unavailable'));

    await expect(ensureKeychainKeyForProfile({
      ...profile,
      authMethod: 'key',
    })).rejects.toThrow('failed to load keychain keys: database unavailable');

    expect(useKeychainKeyPromptStore.getState().pending).toBeNull();
  });
});
