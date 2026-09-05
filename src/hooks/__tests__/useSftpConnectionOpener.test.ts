import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSftpConnectionOpener } from '../useSftpConnectionOpener';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import { useSftpStore } from '@/stores/sftpStore';
import { useToastStore } from '@/stores/toastStore';
import type { ConnectionProfile } from '@/types';

vi.mock('@/lib/ipc/tauri', () => ({
  buildRemoteConnectionRequest: vi.fn((profile: ConnectionProfile) => profile),
  invokeCheckHostKey: vi.fn(),
  invokeTrustHost: vi.fn(),
  invokeWarmRemoteConnection: vi.fn().mockResolvedValue(undefined),
  parseRemoteFsError: vi.fn((error: unknown) => {
    if (typeof error !== 'object' || error === null || !('type' in error)) return null;
    const type = (error as { type?: string }).type;
    return type === 'HostKeyUnknown' || type === 'HostKeyMismatch' || type === 'Other'
      ? error
      : null;
  }),
  invokeStoreProfilePassword: vi.fn().mockResolvedValue(undefined),
  invokeRetrieveProfilePassword: vi.fn().mockResolvedValue(undefined),
  invokeRetrieveProfileSecret: vi.fn().mockResolvedValue(undefined),
  invokeTouchRecentProfile: vi.fn().mockResolvedValue(undefined),
  invokeRemoveRecentProfile: vi.fn().mockResolvedValue(undefined),
  invokeListRecentProfiles: vi.fn().mockResolvedValue([]),
  invokeAddSftpBookmark: vi.fn().mockResolvedValue(undefined),
  invokeRemoveSftpBookmark: vi.fn().mockResolvedValue(undefined),
  invokeListSftpBookmarks: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/connections/password-prompt', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/connections/password-prompt')>();
  return {
    ...actual,
    promptForMissingPassword: vi.fn((p: ConnectionProfile) => Promise.resolve(p)),
  };
});

vi.mock('@/lib/connections/keychain-key-prompt', () => ({
  ensureKeychainKeyForProfile: vi.fn().mockImplementation((p) => Promise.resolve(p)),
}));

import {
  invokeCheckHostKey,
  invokeListSftpBookmarks,
  invokeRetrieveProfilePassword,
  invokeRetrieveProfileSecret,
  invokeStoreProfilePassword,
  invokeTrustHost,
  invokeWarmRemoteConnection,
} from '@/lib/ipc/tauri';
import { promptForMissingPassword } from '@/lib/connections/password-prompt';
import {
  ensureKeychainKeyForProfile,
} from '@/lib/connections/keychain-key-prompt';

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
const initialToast = useToastStore.getState();

describe('useSftpConnectionOpener', () => {
  beforeEach(() => {
    useAppStore.setState(initialApp, true);
    useProfileStore.setState(initialProfile, true);
    useRecentProfilesStore.setState(initialRecent, true);
    useSftpStore.setState(initialSftp, true);
    useToastStore.setState(initialToast, true);
    vi.mocked(invokeCheckHostKey).mockReset();
    vi.mocked(invokeTrustHost).mockReset();
    vi.mocked(invokeTrustHost).mockResolvedValue(undefined);
    vi.mocked(invokeWarmRemoteConnection).mockReset();
    vi.mocked(invokeWarmRemoteConnection).mockResolvedValue(undefined);
    vi.mocked(invokeStoreProfilePassword).mockReset();
    vi.mocked(invokeStoreProfilePassword).mockResolvedValue(undefined);
    vi.mocked(invokeRetrieveProfilePassword).mockReset();
    vi.mocked(invokeRetrieveProfilePassword).mockResolvedValue(undefined);
    vi.mocked(invokeRetrieveProfileSecret).mockReset();
    vi.mocked(invokeRetrieveProfileSecret).mockResolvedValue(undefined);
    vi.mocked(promptForMissingPassword).mockReset();
    vi.mocked(promptForMissingPassword).mockImplementation((p) => Promise.resolve(p));
    vi.mocked(ensureKeychainKeyForProfile).mockReset();
    vi.mocked(ensureKeychainKeyForProfile).mockImplementation((p) => Promise.resolve(p));
  });

  it('opens a known direct host through one formal pooled connection attempt', async () => {
    const { result } = renderHook(() => useSftpConnectionOpener());

    await act(async () => {
      await result.current.open(profile);
    });

    expect(invokeCheckHostKey).not.toHaveBeenCalled();
    expect(invokeWarmRemoteConnection).toHaveBeenCalledTimes(1);
    expect(invokeWarmRemoteConnection).toHaveBeenCalledWith(profile);
    expect(useSftpStore.getState().connections).toHaveLength(1);
    expect(useAppStore.getState().activeSection).toBe('sftp');
    expect(result.current.hostKeyDialog.open).toBe(false);
    expect(invokeListSftpBookmarks).toHaveBeenCalledWith(
      profile.host,
      profile.port,
      profile.username,
    );
  });

  it('keeps the standalone host-key check for an already open pane', async () => {
    vi.mocked(invokeCheckHostKey).mockResolvedValueOnce({ status: 'match' });
    const onVerified = vi.fn();
    const { result } = renderHook(() => useSftpConnectionOpener());

    await act(async () => {
      await result.current.verifyHostKey(profile.host, profile.port, onVerified);
    });

    expect(invokeCheckHostKey).toHaveBeenCalledWith(profile.host, profile.port);
    expect(invokeWarmRemoteConnection).not.toHaveBeenCalled();
    expect(onVerified).toHaveBeenCalledTimes(1);
  });

  it('binds an initial directory to the newly opened host pane', async () => {
    const { result } = renderHook(() => useSftpConnectionOpener());

    await act(async () => {
      await result.current.open(profile, undefined, 'remote', '/srv/releases');
    });

    const connection = useSftpStore.getState().connections[0];
    expect(connection?.profileId).toBe(profile.id);
    expect(connection?.remotePath).toBe('/srv/releases');
  });

  it('asks for confirmation before trusting an unknown host and opening SFTP', async () => {
    vi.mocked(invokeWarmRemoteConnection).mockRejectedValueOnce({
      type: 'HostKeyUnknown',
      payload: {
        host: '175.178.66.45',
        port: 22,
        fingerprint: 'ED25519 SHA256:fingerprint',
      },
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
    expect(invokeTrustHost).toHaveBeenCalledWith(
      '175.178.66.45',
      22,
      'ED25519 SHA256:fingerprint',
    );
    expect(invokeWarmRemoteConnection).toHaveBeenCalledTimes(2);
    expect(invokeCheckHostKey).not.toHaveBeenCalled();
    expect(result.current.hostKeyDialog.open).toBe(false);
  });

  it('prompts again if the host key changes again after trust', async () => {
    vi.mocked(invokeWarmRemoteConnection)
      .mockRejectedValueOnce({
        type: 'HostKeyMismatch',
        payload: {
          host: profile.host,
          port: profile.port,
          fingerprint: 'ED25519 SHA256:first-change',
        },
      })
      .mockRejectedValueOnce({
        type: 'HostKeyMismatch',
        payload: {
          host: profile.host,
          port: profile.port,
          fingerprint: 'ED25519 SHA256:second-change',
        },
      });
    const { result } = renderHook(() => useSftpConnectionOpener());

    await act(async () => {
      await result.current.open(profile);
    });

    expect(result.current.hostKeyDialog).toMatchObject({
      open: true,
      host: profile.host,
      port: profile.port,
      fingerprint: 'ED25519 SHA256:first-change',
      mismatch: true,
    });

    act(() => {
      result.current.hostKeyDialog.onTrust();
    });

    await waitFor(() => {
      expect(invokeWarmRemoteConnection).toHaveBeenCalledTimes(2);
      expect(result.current.hostKeyDialog).toMatchObject({
        open: true,
        fingerprint: 'ED25519 SHA256:second-change',
        mismatch: true,
      });
    });
    expect(invokeTrustHost).toHaveBeenCalledWith(
      profile.host,
      profile.port,
      'ED25519 SHA256:first-change',
    );
    expect(useSftpStore.getState().connections).toHaveLength(0);
  });

  it('keeps authentication errors out of the workspace and reports them', async () => {
    vi.mocked(invokeWarmRemoteConnection).mockRejectedValueOnce({
      type: 'Other',
      payload: { message: 'password auth failed: authentication failed' },
    });
    const { result } = renderHook(() => useSftpConnectionOpener());

    await act(async () => {
      await result.current.open(profile);
    });

    expect(invokeWarmRemoteConnection).toHaveBeenCalledTimes(1);
    expect(invokeCheckHostKey).not.toHaveBeenCalled();
    expect(useSftpStore.getState().connections).toHaveLength(0);
    expect(result.current.hostKeyDialog.open).toBe(false);
    const toasts = useToastStore.getState().toasts;
    expect(toasts[toasts.length - 1]).toMatchObject({
      variant: 'error',
    });
  });

  it('ensures the keychain key before opening SFTP and uses the recovered profile', async () => {
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

  it('persists a password entered via the prompt after opening SFTP', async () => {
    const passwordProfile: ConnectionProfile = {
      ...profile,
      authMethod: 'password',
    };
    vi.mocked(promptForMissingPassword).mockResolvedValueOnce({
      ...passwordProfile,
      password: 'entered-secret',
    });

    const { result } = renderHook(() => useSftpConnectionOpener());

    await act(async () => {
      await result.current.open(passwordProfile);
    });

    await waitFor(() => {
      expect(invokeStoreProfilePassword).toHaveBeenCalledWith('p1', 'entered-secret');
    });
    expect(useSftpStore.getState().connections).toHaveLength(1);
  });

  it('does not persist a password the profile already had', async () => {
    const passwordProfile: ConnectionProfile = {
      ...profile,
      authMethod: 'password',
      password: 'saved-secret',
    };

    const { result } = renderHook(() => useSftpConnectionOpener());

    await act(async () => {
      await result.current.open(passwordProfile);
    });

    expect(invokeStoreProfilePassword).not.toHaveBeenCalled();
    expect(useSftpStore.getState().connections).toHaveLength(1);
  });
});
