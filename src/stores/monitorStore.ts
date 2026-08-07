import { create } from 'zustand';
import type { DisconnectEvent, HealthStatus, SystemHealth } from '@/types';
import { invokeGetSystemHealth } from '@/lib/tauri';
import { deriveHealthStatus } from '@/lib/monitor';

export const MONITOR_POLL_INTERVAL_MS = 2000;
export const MONITOR_HISTORY_LIMIT = 60;
export const MONITOR_DISCONNECT_LIMIT = 20;

export interface MonitorSample {
  ts: number;
  rssBytes: number;
  cpuPercent: number;
}

interface MonitorState {
  snapshot?: SystemHealth;
  history: MonitorSample[];
  status: HealthStatus;
  loading: boolean;
  error?: string;
  lastUpdatedAt?: number;
  paused: boolean;
  /** Bounded history of non-local terminal disconnects, newest last. */
  disconnectEvents: DisconnectEvent[];
  recordDisconnect: (event: DisconnectEvent) => void;
  setPaused: (paused: boolean) => void;
  refresh: () => Promise<void>;
  clear: () => void;
}

export const useMonitorStore = create<MonitorState>()((set, get) => ({
  snapshot: undefined,
  history: [],
  status: 'ok',
  loading: false,
  error: undefined,
  lastUpdatedAt: undefined,
  paused: false,
  disconnectEvents: [],

  recordDisconnect: (event) =>
    set((state) => {
      const events = [...state.disconnectEvents, event];
      const trimmed =
        events.length > MONITOR_DISCONNECT_LIMIT
          ? events.slice(events.length - MONITOR_DISCONNECT_LIMIT)
          : events;
      return { disconnectEvents: trimmed };
    }),

  setPaused: (paused) => set({ paused }),

  refresh: async () => {
    if (get().paused) {
      return;
    }
    if (get().snapshot === undefined) {
      set({ loading: true });
    }
    try {
      const snapshot = await invokeGetSystemHealth();
      const ts = Date.now();
      const sample: MonitorSample = {
        ts,
        rssBytes: snapshot.app.rssBytes,
        cpuPercent: snapshot.app.cpuPercent,
      };
      set((state) => {
        const history = [...state.history, sample];
        const trimmed =
          history.length > MONITOR_HISTORY_LIMIT
            ? history.slice(history.length - MONITOR_HISTORY_LIMIT)
            : history;
        return {
          snapshot,
          history: trimmed,
          status: deriveHealthStatus(snapshot),
          error: undefined,
          lastUpdatedAt: ts,
          loading: false,
        };
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        status: 'error',
        loading: false,
      });
    }
  },

  clear: () =>
    set({
      snapshot: undefined,
      history: [],
      status: 'ok',
      error: undefined,
      lastUpdatedAt: undefined,
      disconnectEvents: [],
    }),
}));
