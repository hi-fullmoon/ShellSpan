import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMonitorStore, MONITOR_HISTORY_LIMIT, MONITOR_DISCONNECT_LIMIT } from '../monitorStore';
import type { DisconnectEvent, SystemHealth } from '@/types';

const { invokeGetSystemHealth } = vi.hoisted(() => ({
  invokeGetSystemHealth: vi.fn(),
}));

vi.mock('@/lib/ipc/tauri', () => ({
  invokeGetSystemHealth,
}));

function makeHealth(memoryUsagePercent: number, rssBytes = 248): SystemHealth {
  return {
    app: {
      pid: 1,
      rssBytes,
      vszBytes: rssBytes * 4,
      cpuPercent: 3.2,
      uptimeSecs: 8000,
    },
    system: {
      totalMemoryBytes: 100,
      usedMemoryBytes: memoryUsagePercent,
      freeMemoryBytes: 100 - memoryUsagePercent,
      memoryUsagePercent,
      totalSwapBytes: 0,
      usedSwapBytes: 0,
      freeSwapBytes: 0,
      cpuPercent: 12,
    },
    disk: {
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      usagePercent: 0,
      mountPoint: '/',
    },
    appInfo: { version: '1.0.0', platform: 'macos', arch: 'aarch64' },
  };
}

beforeEach(() => {
  useMonitorStore.getState().clear();
  invokeGetSystemHealth.mockReset();
});

describe('useMonitorStore', () => {
  it('appends a sample and updates snapshot, status and lastUpdatedAt on refresh', async () => {
    invokeGetSystemHealth.mockResolvedValue(makeHealth(50));
    const before = Date.now();
    await useMonitorStore.getState().refresh();

    const state = useMonitorStore.getState();
    expect(state.snapshot?.app.rssBytes).toBe(248);
    expect(state.status).toBe('ok');
    expect(state.error).toBeUndefined();
    expect(state.lastUpdatedAt).toBeGreaterThanOrEqual(before);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ rssBytes: 248, cpuPercent: 3.2 });
    expect(state.loading).toBe(false);
  });

  it('caps the history buffer at the configured limit', async () => {
    const total = MONITOR_HISTORY_LIMIT + 5;
    let call = 0;
    invokeGetSystemHealth.mockImplementation(() =>
      Promise.resolve(makeHealth(50, 100 + call++)),
    );
    const store = useMonitorStore.getState();
    for (let i = 0; i < total; i++) {
      await store.refresh();
    }
    const state = useMonitorStore.getState();
    expect(state.history).toHaveLength(MONITOR_HISTORY_LIMIT);
    // Oldest 5 samples (rss 100..104) were dropped, the 6th..last kept.
    expect(state.history[0].rssBytes).toBe(105);
    expect(state.history[MONITOR_HISTORY_LIMIT - 1].rssBytes).toBe(total + 99);
  });

  it('derives the status from memory pressure', async () => {
    invokeGetSystemHealth.mockResolvedValue(makeHealth(96));
    await useMonitorStore.getState().refresh();
    expect(useMonitorStore.getState().status).toBe('error');
  });

  it('sets error status when the command fails', async () => {
    invokeGetSystemHealth.mockRejectedValue(new Error('boom'));
    await useMonitorStore.getState().refresh();
    const state = useMonitorStore.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('boom');
    expect(state.snapshot).toBeUndefined();
  });

  it('does not invoke the command while paused', async () => {
    useMonitorStore.getState().setPaused(true);
    await useMonitorStore.getState().refresh();
    expect(invokeGetSystemHealth).not.toHaveBeenCalled();
  });

  it('clears all state', async () => {
    invokeGetSystemHealth.mockResolvedValue(makeHealth(50));
    await useMonitorStore.getState().refresh();
    useMonitorStore.getState().clear();
    const state = useMonitorStore.getState();
    expect(state.snapshot).toBeUndefined();
    expect(state.history).toHaveLength(0);
    expect(state.status).toBe('ok');
    expect(state.error).toBeUndefined();
    expect(state.disconnectEvents).toHaveLength(0);
  });
});

describe('useMonitorStore disconnect events', () => {
  function makeDisconnect(index: number): DisconnectEvent {
    return {
      sessionId: `s${index}`,
      host: `host-${index}`,
      reasonKind: 'transport_disconnect',
      retryable: true,
      at: 1000 + index,
    };
  }

  beforeEach(() => {
    useMonitorStore.getState().clear();
  });

  it('appends disconnect events', () => {
    useMonitorStore.getState().recordDisconnect(makeDisconnect(1));
    useMonitorStore.getState().recordDisconnect(makeDisconnect(2));
    const events = useMonitorStore.getState().disconnectEvents;
    expect(events).toHaveLength(2);
    expect(events[0].host).toBe('host-1');
    expect(events[1].host).toBe('host-2');
  });

  it('caps the disconnect history at the configured limit', () => {
    const store = useMonitorStore.getState();
    for (let i = 0; i < MONITOR_DISCONNECT_LIMIT + 5; i++) {
      store.recordDisconnect(makeDisconnect(i));
    }
    const events = useMonitorStore.getState().disconnectEvents;
    expect(events).toHaveLength(MONITOR_DISCONNECT_LIMIT);
    expect(events[0].host).toBe('host-5');
  });

  it('clears disconnect events', () => {
    useMonitorStore.getState().recordDisconnect(makeDisconnect(1));
    useMonitorStore.getState().clear();
    expect(useMonitorStore.getState().disconnectEvents).toHaveLength(0);
  });
});
