import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSftpConnectionOpener } from '../useSftpConnectionOpener';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { useSftpStore } from '@/stores/sftpStore';
import type { ConnectionProfile } from '@/types';

vi.mock('@/lib/tauri', () => ({
  buildRemoteConnectionRequest: vi.fn((profile: ConnectionProfile) => profile),
  invokeCheckHostKey: vi.fn(),
  invokeTrustHost: vi.fn(),
  invokeTouchRecentProfile: vi.fn().mockResolvedValue(undefined),
  invokeRemoveRecentProfile: vi.fn().mockResolvedValue(undefined),
  invokeListRecentProfiles: vi.fn().mockResolvedValue([]),
  invokeAddSftpBookmark: vi.fn().mockResolvedValue(undefined),
  invokeRemoveSftpBookmark: vi.fn().mockResolvedValue(undefined),
  invokeListSftpBookmarks: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/keychain-key-prompt', () => ({
  ensureKeychainKeyForProfile: vi.fn().mockImplementation((p) => Promise.resolve(p)),
  ensurePasswordKeychain: vi.fn().mockImplementation((p) => Promise.resolve(p)),
  prepareKeychainKeyForProfile: vi.fn().mockImplementation((p) => Promise.resolve(p)),
}));

import { invokeCheckHostKey, invokeListSftpBookmarks, invokeTrustHost } from '@/lib/tauri';
import {
  ensureKeychainKeyForProfile,
  ensurePasswordKeychain,
  prepareKeychainKeyForProfile,
} from '@/lib/keychain-key-prompt';

const profile: ConnectionProfile = {
  id: 'p1',
  name: 'Server',
  host: '175.178.66.45',
  port: 22,
  username: 'root',
  authMethod: 'key',
  createdAt: 0,
  updatedAt: 0,
};

const initialApp = useAppStore.getState();
const initialProfile = useProfileStore.getState();
const initialRecent = useRecentProfilesStore.getState();
const initialSftp = useSftpStore.getState();

describe('useSftpConnectionOpener', () => {
  beforeEach(() => {
    useAppStore.setState(initialApp, true);
    useProfileStore.setState(initialProfile, true);
    useRecentProfilesStore.setState(initialRecent, true);
    useSftpStore.setState(initialSftp, true);
    vi.mocked(invokeCheckHostKey).mockReset();
    vi.mocked(invokeTrustHost).mockReset();
    vi.mocked(invokeTrustHost).mockResolvedValue(undefined);
    vi.mocked(ensureKeychainKeyForProfile).mockReset();
    vi.mocked(ensureKeychainKeyForProfile).mockImplementation((p) => Promise.resolve(p));
    vi.mocked(ensurePasswordKeychain).mockReset();
    vi.mocked(ensurePasswordKeychain).mockImplementation((p) => Promise.resolve(p));
    vi.mocked(prepareKeychainKeyForProfile).mockReset();
    vi.mocked(prepareKeychainKeyForProfile).mockImplementation((p) => Promise.resolve(p));
  });

  it('opens SFTP immediately when the host key matches', async () => {
    vi.mocked(invokeCheckHostKey).mockResolvedValue({ status: 'match' });
    const { result } = renderHook(() => useSftpConnectionOpener());

    await act(async () => {
      await result.current.open(profile);
    });

    expect(invokeCheckHostKey).toHaveBeenCalledWith('175.178.66.45', 22);
    expect(useSftpStore.getState().connections).toHaveLength(1);
    expect(useAppStore.getState().activeSection).toBe('sftp');
    expect(result.current.hostKeyDialog.open).toBe(false);
    expect(invokeListSftpBookmarks).toHaveBeenCalledWith(
      profile.host,
      profile.port,
      profile.username,
    );
  });

  it('asks for confirmation before trusting an unknown host and opening SFTP', async () => {
    vi.mocked(invokeCheckHostKey).mockResolvedValue({
      status: 'notFound',
      fingerprint: 'ED25519 SHA256:fingerprint',
    });
    const { result } = renderHook(() => useSftpConnectionOpener());

    await act(async () => {
      await result.current.open(profile);
    });

    expect(useSftpStore.getState().connections).toHaveLength(0);
    expect(result.current.hostKeyDialog).toMatchObject({
      open: true,
      host: '175.178.66.45',
      port: 22,
      fingerprint: 'ED25519 SHA256:fingerprint',
      mismatch: false,
    });

    act(() => {
      result.current.hostKeyDialog.onTrust();
    });

    await waitFor(() => {
      expect(useSftpStore.getState().connections).toHaveLength(1);
    });
    expect(invokeTrustHost).toHaveBeenCalledWith('175.178.66.45', 22);
    expect(result.current.hostKeyDialog.open).toBe(false);
  });

  it('ensures the keychain key before opening SFTP and uses the recovered profile', async () => {
    vi.mocked(invokeCheckHostKey).mockResolvedValue({ status: 'match' });
    const keychainProfile: ConnectionProfile = {
      ...profile,
      authMethod: 'key',
      keychainKeyId: 'old-key',
    };
    const recoveredProfile: ConnectionProfile = {
      ...keychainProfile,
      keychainKeyId: 'new-key',
    };
    vi.mocked(ensureKeychainKeyForProfile).mockResolvedValueOnce(recoveredProfile);

    const { result } = renderHook(() => useSftpConnectionOpener());

    await act(async () => {
      await result.current.open(keychainProfile);
    });

    expect(ensureKeychainKeyForProfile).toHaveBeenCalledWith(keychainProfile);
    expect(useSftpStore.getState().connections).toHaveLength(1);
    expect(useSftpStore.getState().connections[0]?.connection.keychainKeyId).toBe('new-key');
  });
});
