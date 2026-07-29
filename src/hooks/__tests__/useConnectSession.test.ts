import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useConnectSession } from '../useConnectSession';
import { useProfileStore } from '@/stores/profileStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { useAppStore } from '@/stores/appStore';
import { useRecentProfilesStore } from '@/stores/recentProfilesStore';
import type { ConnectionProfile } from '@/types';

vi.mock('@/lib/tauri', () => ({
  invokeCreateSession: vi.fn(),
  invokeTrustHost: vi.fn(),
  invokeStoreProfilePassword: vi.fn().mockResolvedValue(undefined),
  buildSessionCreateRequest: vi.fn((p: ConnectionProfile) => p),
  invokeWriteSession: vi.fn().mockResolvedValue(undefined),
  invokeResizeSession: vi.fn().mockResolvedValue(undefined),
  buildRemoteConnectionRequest: vi.fn(),
  invokeTouchRecentProfile: vi.fn().mockResolvedValue(undefined),
  invokeRemoveRecentProfile: vi.fn().mockResolvedValue(undefined),
  invokeListRecentProfiles: vi.fn().mockResolvedValue([]),
  listenToSessionError: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock('@/locales', () => ({
  t: (key: string) =>
    key === 'error.keychainKeyNotFound'
      ? '该连接配置的已保存密钥已不存在，请选择其他密钥。'
      : key,
  changeLocale: vi.fn(),
  initI18n: vi.fn(),
}));

vi.mock('../useReconnectSession', () => ({
  useReconnectSession: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock('@/lib/password-prompt', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/password-prompt')>();
  return {
    ...actual,
    promptForMissingPassword: vi.fn((p: ConnectionProfile) => Promise.resolve(p)),
  };
});

vi.mock('@/lib/keychain-key-prompt', () => ({
  promptForMissingKeychainKey: vi.fn().mockResolvedValue(null),
  ensureKeychainKeyForProfile: vi.fn().mockImplementation((profile) => Promise.resolve(profile)),
  preparePasswordKeychain: vi.fn().mockImplementation((profile) => Promise.resolve(profile)),
  prepareKeychainKeyForProfile: vi.fn().mockImplementation((profile) => Promise.resolve(profile)),
}));

import {
  invokeCreateSession,
  invokeTrustHost,
  invokeStoreProfilePassword,
} from '@/lib/tauri';
import { promptForMissingPassword } from '@/lib/password-prompt';
import {
  ensureKeychainKeyForProfile,
  prepareKeychainKeyForProfile,
  preparePasswordKeychain,
  promptForMissingKeychainKey,
} from '@/lib/keychain-key-prompt';

const SUMMARY = {
  sessionId: 's1',
  title: 'T',
  host: 'h',
  port: 22,
  username: 'u',
};

const profile: ConnectionProfile = {
  id: 'p1',
  name: 'P',
  host: 'h',
  port: 22,
  username: 'u',
  authMethod: 'key',
  createdAt: 0,
  updatedAt: 0,
};

const initialTerminal = useTerminalStore.getState();
const initialApp = useAppStore.getState();
const initialProfile = useProfileStore.getState();
const initialRecent = useRecentProfilesStore.getState();

describe('useConnectSession', () => {
  beforeEach(() => {
    useTerminalStore.setState(initialTerminal, true);
    useAppStore.setState(initialApp, true);
    useProfileStore.setState(initialProfile, true);
    useRecentProfilesStore.setState(initialRecent, true);
    vi.mocked(invokeCreateSession).mockReset();
    vi.mocked(invokeTrustHost).mockReset();
    vi.mocked(invokeTrustHost).mockResolvedValue(undefined);
    vi.mocked(invokeStoreProfilePassword).mockReset();
    vi.mocked(invokeStoreProfilePassword).mockResolvedValue(undefined);
    vi.mocked(promptForMissingPassword).mockReset();
    vi.mocked(promptForMissingPassword).mockImplementation((p) => Promise.resolve(p));
    vi.mocked(promptForMissingKeychainKey).mockReset();
    vi.mocked(promptForMissingKeychainKey).mockResolvedValue(null);
    vi.mocked(ensureKeychainKeyForProfile).mockReset();
    vi.mocked(ensureKeychainKeyForProfile).mockImplementation((profile) => Promise.resolve(profile));
    vi.mocked(preparePasswordKeychain).mockReset();
    vi.mocked(preparePasswordKeychain).mockImplementation((profile) => Promise.resolve(profile));
    vi.mocked(prepareKeychainKeyForProfile).mockReset();
    vi.mocked(prepareKeychainKeyForProfile).mockImplementation((profile) => Promise.resolve(profile));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('on success calls invokeCreateSession, addSession with profileId and switches to terminal', async () => {
    vi.mocked(invokeCreateSession).mockResolvedValueOnce(SUMMARY);

    const { result } = renderHook(() => useConnectSession());

    await act(async () => {
      await result.current.connect(profile);
    });

    expect(vi.mocked(invokeCreateSession)).toHaveBeenCalledTimes(1);
    const sessions = useTerminalStore.getState().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionId: 's1', profileId: 'p1' });
    expect(useAppStore.getState().activeSection).toBe('terminal');
    expect(useRecentProfilesStore.getState().recentIds).toEqual(['p1']);
    expect(result.current.hostKeyDialog.open).toBe(false);
  });

  it('opens dialog on HostKeyUnknown and trusts then retries', async () => {
    vi.mocked(invokeCreateSession)
      .mockRejectedValueOnce({
        type: 'HostKeyUnknown',
        payload: { host: 'h', port: 22, fingerprint: 'fp' },
      })
      .mockResolvedValueOnce(SUMMARY);

    const { result } = renderHook(() => useConnectSession());

    await act(async () => {
      await result.current.connect(profile);
    });

    expect(result.current.hostKeyDialog).toMatchObject({
      open: true,
      host: 'h',
      port: 22,
      fingerprint: 'fp',
      mismatch: false,
    });

    await act(async () => {
      result.current.hostKeyDialog.onTrust();
    });

    await waitFor(() =>
      expect(vi.mocked(invokeCreateSession)).toHaveBeenCalledTimes(2),
    );
    expect(vi.mocked(invokeTrustHost)).toHaveBeenCalledWith('h', 22);
    expect(result.current.hostKeyDialog.open).toBe(false);
    expect(useTerminalStore.getState().sessions[0]).toMatchObject({
      sessionId: 's1',
      profileId: 'p1',
    });
  });

  it('opens dialog with mismatch=true on HostKeyMismatch', async () => {
    vi.mocked(invokeCreateSession).mockRejectedValueOnce({
      type: 'HostKeyMismatch',
      payload: { host: 'h', port: 2222 },
    });

    const { result } = renderHook(() => useConnectSession());

    await act(async () => {
      await result.current.connect(profile);
    });

    expect(result.current.hostKeyDialog).toMatchObject({
      open: true,
      host: 'h',
      port: 2222,
      mismatch: true,
    });
    expect(result.current.hostKeyDialog.fingerprint).toBeUndefined();
  });

  it('shows a toast and keeps dialog closed on other errors', async () => {
    const addToast = vi.fn();
    vi.spyOn(
      (await import('@/stores/toastStore')).useToastStore,
      'getState',
    ).mockReturnValue({
      toasts: [],
      addToast,
      removeToast: vi.fn(),
    });
    vi.mocked(invokeCreateSession).mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useConnectSession());

    await act(async () => {
      await result.current.connect(profile);
    });

    expect(addToast).toHaveBeenCalledWith('boom', 'error');
    expect(result.current.hostKeyDialog.open).toBe(false);
  });

  it('shows the original message for non-recoverable Other errors', async () => {
    const passwordProfile: ConnectionProfile = { ...profile, authMethod: 'password', password: 'secret' };
    const addToast = vi.fn();
    vi.spyOn(
      (await import('@/stores/toastStore')).useToastStore,
      'getState',
    ).mockReturnValue({
      toasts: [],
      addToast,
      removeToast: vi.fn(),
    });
    vi.mocked(invokeCreateSession).mockRejectedValueOnce({
      type: 'Other',
      payload: { message: 'authentication failed' },
    });

    const { result } = renderHook(() => useConnectSession());

    await act(async () => {
      await result.current.connect(passwordProfile);
    });

    expect(addToast).toHaveBeenCalledWith('authentication failed', 'error');
    expect(result.current.hostKeyDialog.open).toBe(false);
  });

  it('prompts for replacement key on keychain key not found and retries', async () => {
    const keychainProfile: ConnectionProfile = {
      ...profile,
      authMethod: 'key',
      keychainKeyId: 'old-key',
    };
    const recoveredProfile: ConnectionProfile = {
      ...keychainProfile,
      keychainKeyId: 'new-key',
    };

    vi.mocked(invokeCreateSession)
      .mockRejectedValueOnce({
        type: 'Other',
        payload: { message: 'keychain key not found: old-key' },
      })
      .mockResolvedValueOnce(SUMMARY);
    vi.mocked(promptForMissingKeychainKey).mockResolvedValueOnce(recoveredProfile);

    const { result } = renderHook(() => useConnectSession());

    await act(async () => {
      await result.current.connect(keychainProfile);
    });

    expect(promptForMissingKeychainKey).toHaveBeenCalledWith(keychainProfile);
    expect(invokeCreateSession).toHaveBeenCalledTimes(2);
    expect(useTerminalStore.getState().sessions).toHaveLength(1);
    expect(useTerminalStore.getState().sessions[0]).toMatchObject({
      sessionId: 's1',
      profileId: 'p1',
    });
  });

  it('cancels connection when key prompt is dismissed', async () => {
    const keychainProfile: ConnectionProfile = {
      ...profile,
      authMethod: 'key',
      keychainKeyId: 'old-key',
    };
    const addToast = vi.fn();
    vi.spyOn(
      (await import('@/stores/toastStore')).useToastStore,
      'getState',
    ).mockReturnValue({
      toasts: [],
      addToast,
      removeToast: vi.fn(),
    });
    vi.mocked(invokeCreateSession).mockRejectedValueOnce({
      type: 'Other',
      payload: { message: 'keychain key not found: old-key' },
    });

    const { result } = renderHook(() => useConnectSession());

    await act(async () => {
      await result.current.connect(keychainProfile);
    });

    expect(promptForMissingKeychainKey).toHaveBeenCalledWith(keychainProfile);
    expect(addToast).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
  });

  it('closeHostKeyDialog resets to the closed default', async () => {
    vi.mocked(invokeCreateSession).mockRejectedValueOnce({
      type: 'HostKeyUnknown',
      payload: { host: 'h', port: 22, fingerprint: 'fp' },
    });

    const { result } = renderHook(() => useConnectSession());

    await act(async () => {
      await result.current.connect(profile);
    });
    expect(result.current.hostKeyDialog.open).toBe(true);

    act(() => {
      result.current.closeHostKeyDialog();
    });

    expect(result.current.hostKeyDialog).toMatchObject({
      open: false,
      host: '',
      port: 22,
      mismatch: false,
    });
    expect(result.current.hostKeyDialog.onTrust).toBeInstanceOf(Function);
  });

  it('persists a password entered via the prompt after a successful connection', async () => {
    const passwordProfile: ConnectionProfile = {
      ...profile,
      authMethod: 'password',
    };
    vi.mocked(promptForMissingPassword).mockResolvedValueOnce({
      ...passwordProfile,
      password: 'entered-secret',
    });
    vi.mocked(invokeCreateSession).mockResolvedValueOnce(SUMMARY);

    const { result } = renderHook(() => useConnectSession());

    await act(async () => {
      await result.current.connect(passwordProfile);
    });

    expect(invokeStoreProfilePassword).toHaveBeenCalledWith('p1', 'entered-secret');
    expect(useTerminalStore.getState().sessions).toHaveLength(1);
  });

  it('does not persist a password the profile already had', async () => {
    const passwordProfile: ConnectionProfile = {
      ...profile,
      authMethod: 'password',
      password: 'saved-secret',
    };
    vi.mocked(invokeCreateSession).mockResolvedValueOnce(SUMMARY);

    const { result } = renderHook(() => useConnectSession());

    await act(async () => {
      await result.current.connect(passwordProfile);
    });

    expect(invokeStoreProfilePassword).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().sessions).toHaveLength(1);
  });

  it('keeps the connection when persisting the prompted password fails', async () => {
    const passwordProfile: ConnectionProfile = {
      ...profile,
      authMethod: 'password',
    };
    vi.mocked(promptForMissingPassword).mockResolvedValueOnce({
      ...passwordProfile,
      password: 'entered-secret',
    });
    vi.mocked(invokeStoreProfilePassword).mockRejectedValueOnce(new Error('keyring unavailable'));
    vi.mocked(invokeCreateSession).mockResolvedValueOnce(SUMMARY);

    const { result } = renderHook(() => useConnectSession());

    await act(async () => {
      await result.current.connect(passwordProfile);
    });

    expect(invokeStoreProfilePassword).toHaveBeenCalledWith('p1', 'entered-secret');
    expect(useTerminalStore.getState().sessions).toHaveLength(1);
    expect(useAppStore.getState().activeSection).toBe('terminal');
  });
});
