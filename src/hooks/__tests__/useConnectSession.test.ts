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
  buildSessionCreateRequest: vi.fn((p: ConnectionProfile) => p),
  invokeWriteSession: vi.fn().mockResolvedValue(undefined),
  invokeResizeSession: vi.fn().mockResolvedValue(undefined),
  invokeRetrievePassword: vi.fn().mockResolvedValue(null),
  invokeStorePassword: vi.fn().mockResolvedValue(undefined),
  invokeRemovePassword: vi.fn().mockResolvedValue(undefined),
  buildRemoteConnectionRequest: vi.fn(),
  invokeTouchRecentProfile: vi.fn().mockResolvedValue(undefined),
  invokeRemoveRecentProfile: vi.fn().mockResolvedValue(undefined),
  invokeListRecentProfiles: vi.fn().mockResolvedValue([]),
}));

import {
  invokeCreateSession,
  invokeTrustHost,
} from '@/lib/tauri';

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
  authMethod: 'keyPath',
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
});
