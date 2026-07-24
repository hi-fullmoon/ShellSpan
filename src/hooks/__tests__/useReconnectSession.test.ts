import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useReconnectSession } from '../useReconnectSession';
import { useTerminalStore } from '@/stores/terminalStore';
import { useProfileStore } from '@/stores/profileStore';
import { terminalRegistry } from '@/components/terminal/registry/terminal-registry';

vi.mock('@/lib/tauri', () => ({
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
  invokeCloseSession: vi.fn().mockResolvedValue(undefined),
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

vi.mock('@/lib/password-prompt', () => ({
  promptForMissingPassword: vi.fn(
    (profile) => Promise.resolve({ ...profile, password: 'mock-pass' }),
  ),
}));

const initialTerminal = useTerminalStore.getState();
const initialProfile = useProfileStore.getState();

describe('useReconnectSession', () => {
  beforeEach(() => {
    useTerminalStore.setState(initialTerminal, true);
    useProfileStore.setState(initialProfile, true);
    terminalRegistry.disposeAll();
  });

  afterEach(() => {
    terminalRegistry.disposeAll();
    useTerminalStore.setState(initialTerminal, true);
    useProfileStore.setState(initialProfile, true);
  });

  it('does nothing when the session has no profileId', async () => {
    useTerminalStore.getState().addSession({
      sessionId: 's1',
      title: 'A',
      host: 'h',
      port: 22,
      username: 'u',
    });

    const { result } = renderHook(() => useReconnectSession());
    await result.current('s1');

    expect(useTerminalStore.getState().sessions).toHaveLength(1);
    expect(useTerminalStore.getState().sessions[0]?.sessionId).toBe('s1');
  });

  it('creates a new session and replaces the old one on success', async () => {
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
    const controller = terminalRegistry.create(
      's1',
      vi.fn(),
      vi.fn(),
      () => 'disconnected',
      vi.fn(),
    );
    controller.write('existing history\r\n');
    const terminal = controller.terminal;

    const { invokeCreateSession, invokeCloseSession } = await import('@/lib/tauri');
    const { result } = renderHook(() => useReconnectSession());
    await result.current('s1');

    expect(invokeCreateSession).toHaveBeenCalledTimes(1);
    expect(invokeCloseSession).toHaveBeenCalledWith('s1');
    expect(useTerminalStore.getState().sessions[0]?.sessionId).toBe('s2');
    expect(useTerminalStore.getState().activeSessionId).toBe('s2');
    expect(terminalRegistry.get('s2')?.terminal).toBe(terminal);
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

    const { invokeCreateSession } = await import('@/lib/tauri');
    vi.mocked(invokeCreateSession).mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useReconnectSession());
    await result.current('s1');

    const session = useTerminalStore.getState().sessions[0];
    expect(session?.status).toBe('error');
    expect(session?.statusMessage).toBe('boom');
  });
});
