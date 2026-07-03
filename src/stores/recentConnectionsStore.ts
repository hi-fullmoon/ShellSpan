import { create } from 'zustand';
import type { AuthMethod, RecentConnection } from '../types';

interface RecentConnectionsStoreState {
  items: RecentConnection[];
  add: (profile: {
    host: string;
    port: number;
    username: string;
    name?: string;
    authMethod: AuthMethod;
    privateKeyPath?: string;
  }) => void;
  remove: (id: string) => void;
  clear: () => void;
}

const STORAGE_KEY = 'termbridge.recentConnections';
const MAX_ITEMS = 20;

function readStoredItems(): RecentConnection[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as RecentConnection[];
  } catch {
    // ignore
  }
  return [];
}

function writeStoredItems(items: RecentConnection[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore
  }
}

function makeKey(host: string, port: number, username: string): string {
  return `${host}:${port}:${username}`;
}

export const useRecentConnectionsStore = create<RecentConnectionsStoreState>((set) => ({
  items: readStoredItems(),
  add: (profile) =>
    set((state) => {
      const key = makeKey(profile.host, profile.port, profile.username);
      const filtered = state.items.filter(
        (item) => makeKey(item.host, item.port, item.username) !== key,
      );
      const next: RecentConnection = {
        id: crypto.randomUUID(),
        host: profile.host,
        port: profile.port,
        username: profile.username,
        name: profile.name,
        connectedAt: Date.now(),
        authMethod: profile.authMethod,
        privateKeyPath: profile.privateKeyPath,
      };
      const items = [next, ...filtered].slice(0, MAX_ITEMS);
      writeStoredItems(items);
      return { items };
    }),
  remove: (id) =>
    set((state) => {
      const items = state.items.filter((item) => item.id !== id);
      writeStoredItems(items);
      return { items };
    }),
  clear: () => {
    writeStoredItems([]);
    set({ items: [] });
  },
}));
