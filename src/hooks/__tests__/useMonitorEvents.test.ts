import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMonitorEvents } from '../useMonitorEvents';
import { usePortForwardStore } from '@/stores/portForwardStore';
import { useTerminalStore } from '@/stores/terminalStore';

const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));

vi.mock('@tauri-apps/api/event', () => ({ listen }));

const initialPortForward = usePortForwardStore.getState();

describe('useMonitorEvents port-forward lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePortForwardStore.setState(initialPortForward, true);
    useTerminalStore.setState({ sessions: [], activeSessionId: null });
  });

  afterEach(() => {
    usePortForwardStore.setState(initialPortForward, true);
  });

  it('releases the terminal owner on remote disconnect and local close', async () => {
    const handlers = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
    listen.mockImplementation(async (eventName, callback) => {
      handlers.set(eventName, callback);
      return vi.fn();
    });
    const stopOwner = vi.fn().mockResolvedValue(undefined);
    usePortForwardStore.setState({ stopOwner });

    renderHook(() => useMonitorEvents());
    await waitFor(() => expect(handlers.get('ssh-closed')).toBeDefined());

    act(() => {
      handlers.get('ssh-closed')?.({
        payload: {
          sessionId: 'session-1',
          reasonKind: 'transport_disconnect',
          reason: 'connection reset',
          retryable: true,
        },
      });
      handlers.get('ssh-closed')?.({
        payload: {
          sessionId: 'session-2',
          reasonKind: 'local_close',
          retryable: false,
        },
      });
    });

    expect(stopOwner).toHaveBeenNthCalledWith(1, 'terminal:session-1');
    expect(stopOwner).toHaveBeenNthCalledWith(2, 'terminal:session-2');
  });

  it('does not listen for backend-created Agent SSH PTYs or add tabs across repeated turns', async () => {
    const handlers = new Map<string, (event: { payload: Record<string, unknown> }) => void>();
    listen.mockImplementation(async (eventName, callback) => {
      handlers.set(eventName, callback);
      return vi.fn();
    });
    useTerminalStore.getState().addSession({
      sessionId: 'user-ssh-1',
      title: 'Production',
      host: 'prod.example.com',
      port: 22,
      username: 'alice',
    }, 'profile-1');

    renderHook(() => useMonitorEvents());
    await waitFor(() => expect(handlers.get('ssh-closed')).toBeDefined());

    expect(handlers.get('terminal-agent-remote-session-created')).toBeUndefined();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(useTerminalStore.getState().sessions.map((session) => session.sessionId))
      .toEqual(['user-ssh-1']);
  });
});
