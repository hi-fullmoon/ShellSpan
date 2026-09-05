import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useReconnectSession } from '../useReconnectSession';
import { useTerminalStore } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';
import { usePortForwardStore } from '@/stores/portForwardStore';

vi.mock('@/lib/ipc/tauri', () => ({
  invokeGetSessionStatus: vi.fn().mockResolvedValue({
    sessionId: 's1',
    status: 'connected',
    message: 'ready',
  }),
  invokeCreateSession: vi.fn().mockResolvedValue({
    sessionId: 's2',
    title: 'New',
    host: 'h',
    port: 22,
    username: 'u',
  }),
  invokeCreateLocalSession: vi.fn().mockResolvedValue({
    sessionId: 's3',
    title: 'powershell',
    host: 'local',
    port: 0,
    username: 'u',
  }),
  invokeCloseSession: vi.fn().mockResolvedValue(undefined),
  invokeRetrieveProfilePassword: vi.fn().mockResolvedValue(undefined),
  invokeRetrieveProfileSecret: vi.fn().mockResolvedValue(undefined),
  invokeMarkSessionReady: vi.fn().mockResolvedValue(undefined),
  invokeResizeSession: vi.fn().mockResolvedValue(undefined),
  invokeWriteSession: vi.fn().mockResolvedValue(undefined),
  listenToSshData: vi.fn().mockResolvedValue(() => {}),
  listenToSshStatus: vi.fn().mockResolvedValue(() => {}),
  listenToSshClosed: vi.fn().mockResolvedValue(() => {}),
  buildSessionCreateRequest: vi.fn((_profile, cols, rows) => ({
    terminalCols: cols,
    terminalRows: rows,
  })),
}));

vi.mock('@/lib/connections/password-prompt', () => ({
  promptForMissingPassword: vi.fn(
    (profile) => Promise.resolve({ ...profile, password: 'mock-pass' }),
  ),
}));

vi.mock('@/lib/connections/keychain-key-prompt', () => ({
  ensureKeychainKeyForProfile: vi.fn((profile) => Promise.resolve(profile)),
  getMissingKeychainKeyTarget: vi.fn().mockReturnValue(null),
  promptForMissingKeychainKey: vi.fn().mockResolvedValue(null),
}));

import { promptForMissingPassword } from '@/lib/connections/password-prompt';
import {
  ensureKeychainKeyForProfile,
  getMissingKeychainKeyTarget,
  promptForMissingKeychainKey,
} from '@/lib/connections/keychain-key-prompt';

const initialTerminal = useTerminalStore.getState();
const initialProfile = useProfileStore.getState();
const initialPortForward = usePortForwardStore.getState();

describe('useReconnectSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState(initialTerminal, true);
    useProfileStore.setState(initialProfile, true);
    usePortForwardStore.setState(initialPortForward, true);
    terminalRegistry.disposeAll();
    vi.mocked(promptForMissingPassword).mockReset();
    vi.mocked(promptForMissingPassword).mockImplementation((profile) =>
      Promise.resolve({ ...profile, password: 'mock-pass' }),
    );
    vi.mocked(ensureKeychainKeyForProfile).mockReset();
    vi.mocked(ensureKeychainKeyForProfile).mockImplementation((profile) => Promise.resolve(profile));
    vi.mocked(getMissingKeychainKeyTarget).mockReset();
    vi.mocked(getMissingKeychainKeyTarget).mockReturnValue(null);
    vi.mocked(promptForMissingKeychainKey).mockReset();
    vi.mocked(promptForMissingKeychainKey).mockResolvedValue(null);
  });

  afterEach(() => {
    terminalRegistry.disposeAll();
    useTerminalStore.setState(initialTerminal, true);
    useProfileStore.setState(initialProfile, true);
    usePortForwardStore.setState(initialPortForward, true);
  });

  it('recreates a local session when the session has no profileId', async () => {
    useTerminalStore.getState().addSession({
      sessionId: 's1',
      title: 'powershell',
      host: 'local',
      port: 0,
      username: 'u',
    });
    const controller = terminalRegistry.create(
      's1',
      vi.fn(),
      vi.fn(),
      () => 'disconnected',
      vi.fn(),
    );
    const terminal = controller.terminal;

    const { invokeCreateLocalSession, invokeCreateSession, invokeCloseSession } =
      await import('@/lib/ipc/tauri');
    const { result } = renderHook(() => useReconnectSession());
    await result.current('s1');

    expect(invokeCreateLocalSession).toHaveBeenCalledTimes(1);
    expect(invokeCreateSession).not.toHaveBeenCalled();
    expect(invokeCloseSession).toHaveBeenCalledWith('s1');
    expect(useTerminalStore.getState().sessions[0]?.sessionId).toBe('s3');
    expect(terminalRegistry.get('s3')?.terminal).toBe(terminal);
  });

  it('sets status to error when local session creation fails', async () => {
    useTerminalStore.getState().addSession({
      sessionId: 's1',
      title: 'powershell',
      host: 'local',
      port: 0,
      username: 'u',
    });

    const { invokeCreateLocalSession } = await import('@/lib/ipc/tauri');
    vi.mocked(invokeCreateLocalSession).mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useReconnectSession());
    await result.current('s1');

    const session = useTerminalStore.getState().sessions[0];
    expect(session?.status).toBe('error');
    expect(session?.statusMessage).toBe('boom');
  });

  it('creates a new session and replaces the old one on success', async () => {
    const startAutoForOwner = vi.fn().mockResolvedValue(undefined);
    usePortForwardStore.setState({ startAutoForOwner });
    useProfileStore.setState({
      profiles: [
        {
          id: 'p1',
          name: 'Alpha',
          host: 'h',
          port: 22,
          username: 'u',
          authMethod: 'password',
          portForwards: [{
            id: 'forward-1',
            name: 'Database',
            kind: 'local',
            localPort: 15432,
            remoteHost: '127.0.0.1',
            remotePort: 5432,
            autoStart: true,
          }],
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    useTerminalStore.getState().addSession(
      { sessionId: 's1', title: 'A', host: 'h', port: 22, username: 'u' },
      'p1',
    );
    const controller = terminalRegistry.create(
      's1',
      vi.fn(),
      vi.fn(),
      () => 'disconnected',
      vi.fn(),
    );
    controller.write('existing history\r\n');
    const terminal = controller.terminal;

    const { invokeCreateSession, invokeCloseSession } = await import('@/lib/ipc/tauri');
    const { result } = renderHook(() => useReconnectSession());
    await result.current('s1');

    expect(invokeCreateSession).toHaveBeenCalledTimes(1);
    expect(ensureKeychainKeyForProfile).toHaveBeenCalledWith(expect.objectContaining({
      id: 'p1',
      password: 'mock-pass',
    }));
    expect(invokeCloseSession).toHaveBeenCalledWith('s1');
    expect(useTerminalStore.getState().sessions[0]?.sessionId).toBe('s2');
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');
    expect(terminalRegistry.get('s2')?.terminal).toBe(terminal);
    expect(startAutoForOwner).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', password: 'mock-pass' }),
      'terminal:s2',
    );
  });

  it('closes a replacement created after the source session was removed', async () => {
    const profile = {
      id: 'p1',
      name: 'Alpha',
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'password' as const,
      createdAt: 0,
      updatedAt: 0,
    };
    useProfileStore.setState({ profiles: [profile] });
    useTerminalStore.getState().addSession(
      { sessionId: 's1', title: 'A', host: 'h', port: 22, username: 'u' },
      'p1',
    );

    const { invokeCreateSession, invokeCloseSession } = await import('@/lib/ipc/tauri');
    let resolveCreate!: (summary: {
      sessionId: string;
      title: string;
      host: string;
      port: number;
      username: string;
    }) => void;
    vi.mocked(invokeCreateSession).mockImplementationOnce(() => new Promise((resolve) => {
      resolveCreate = resolve;
    }));

    const { result } = renderHook(() => useReconnectSession());
    const reconnectPromise = result.current('s1');
    await vi.waitFor(() => expect(invokeCreateSession).toHaveBeenCalledTimes(1));
    useTerminalStore.getState().removeSession('s1');
    resolveCreate({ sessionId: 's2', title: 'New', host: 'h', port: 22, username: 'u' });
    await reconnectPromise;

    expect(invokeCloseSession).toHaveBeenCalledWith('s2');
    expect(useTerminalStore.getState().sessions).toHaveLength(0);
    expect(terminalRegistry.get('s2')).toBeUndefined();
  });

  it('sets status to error when create session fails', async () => {
    useProfileStore.setState({
      profiles: [
        {
          id: 'p1',
          name: 'Alpha',
          host: 'h',
          port: 22,
          username: 'u',
          authMethod: 'password',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    useTerminalStore.getState().addSession(
      { sessionId: 's1', title: 'A', host: 'h', port: 22, username: 'u' },
      'p1',
    );

    const { invokeCreateSession } = await import('@/lib/ipc/tauri');
    vi.mocked(invokeCreateSession).mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useReconnectSession());
    await result.current('s1');

    const session = useTerminalStore.getState().sessions[0];
    expect(session?.status).toBe('error');
    expect(session?.statusMessage).toBe('boom');
  });

  it('prompts for a replacement key and retries when reconnecting with a missing keychain key', async () => {
    const keyProfile = {
      id: 'p1',
      name: 'Alpha',
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'key' as const,
      keychainKeyId: 'old-key',
      createdAt: 0,
      updatedAt: 0,
    };
    const recoveredProfile = {
      ...keyProfile,
      keychainKeyId: 'new-key',
    };
    useProfileStore.setState({ profiles: [keyProfile] });
    useTerminalStore.getState().addSession(
      { sessionId: 's1', title: 'A', host: 'h', port: 22, username: 'u' },
      'p1',
    );

    const { invokeCreateSession } = await import('@/lib/ipc/tauri');
    vi.mocked(invokeCreateSession).mockClear();
    vi.mocked(invokeCreateSession)
      .mockRejectedValueOnce({
        type: 'Other',
        payload: { message: 'keychain key not found: old-key' },
      })
      .mockResolvedValueOnce({
        sessionId: 's2',
        title: 'New',
        host: 'h',
        port: 22,
        username: 'u',
      });
    vi.mocked(getMissingKeychainKeyTarget).mockReturnValueOnce('main');
    vi.mocked(promptForMissingKeychainKey).mockResolvedValueOnce(recoveredProfile);

    const { result } = renderHook(() => useReconnectSession());
    await result.current('s1');

    expect(promptForMissingKeychainKey).toHaveBeenCalledWith(expect.objectContaining({
      id: 'p1',
      keychainKeyId: 'old-key',
    }), 'main');
    expect(invokeCreateSession).toHaveBeenCalledTimes(2);
    expect(useTerminalStore.getState().sessions[0]?.sessionId).toBe('s2');
  });
});
