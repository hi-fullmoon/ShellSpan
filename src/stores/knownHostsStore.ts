import { create } from 'zustand';
import type { KnownHostEntry } from '@/types';
import {
  invokeListKnownHosts,
  invokeRemoveKnownHost,
  invokeTrustHost,
} from '@/lib/tauri';

interface KnownHostsState {
  hosts: KnownHostEntry[];
  loading: boolean;
  error?: string;
  loadHosts: () => Promise<void>;
  removeHost: (host: string, port: number) => Promise<void>;
  trustHost: (host: string, port: number) => Promise<void>;
}

export const useKnownHostsStore = create<KnownHostsState>()((set) => ({
  hosts: [],
  loading: false,
  loadHosts: async () => {
    set({ loading: true, error: undefined });
    try {
      const hosts = await invokeListKnownHosts();
      set({ hosts, loading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
        loading: false,
      });
    }
  },
  removeHost: async (host, port) => {
    await invokeRemoveKnownHost(host, port);
    set((state) => ({
      hosts: state.hosts.filter(
        (h) => !(h.host === host && h.port === port),
      ),
    }));
  },
  trustHost: async (host, port) => {
    await invokeTrustHost(host, port);
  },
}));
