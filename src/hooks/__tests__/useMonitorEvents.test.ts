import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMonitorEvents } from '../useMonitorEvents';
import { usePortForwardStore } from '@/stores/portForwardStore';

const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));

vi.mock('@tauri-apps/api/event', () => ({ listen }));

const initialPortForward = usePortForwardStore.getState();

describe('useMonitorEvents port-forward lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePortForwardStore.setState(initialPortForward, true);
  });

  afterEach(() => {
    usePortForwardStore.setState(initialPortForward, true);
  });

  it('releases the terminal owner on remote disconnect and local close', async () => {
    let handler: ((event: { payload: Record<string, unknown> }) => void) | undefined;
    listen.mockImplementation(async (_eventName, callback) => {
      handler = callback;
      return vi.fn();
    });
    const stopOwner = vi.fn().mockResolvedValue(undefined);
    usePortForwardStore.setState({ stopOwner });

    renderHook(() => useMonitorEvents());
    await waitFor(() => expect(handler).toBeDefined());

    act(() => {
      handler?.({
        payload: {
          sessionId: 'session-1',
          reasonKind: 'transport_disconnect',
          reason: 'connection reset',
          retryable: true,
        },
      });
      handler?.({
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
});
