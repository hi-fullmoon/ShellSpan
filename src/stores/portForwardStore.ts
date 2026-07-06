import { create } from 'zustand';
import type { PortForwardConfig } from '@/types';
import {
  invokeStartPortForwards,
  invokeStopPortForwards,
} from '@/lib/tauri';

export interface ActivePortForward {
  operationId: string;
  connectionKey: string;
  forwards: PortForwardConfig[];
}

interface PortForwardState {
  active: ActivePortForward[];
  addActive: (active: ActivePortForward) => void;
  removeActive: (operationId: string) => void;
  isActive: (connectionKey: string) => boolean;
  findByConnection: (connectionKey: string) => ActivePortForward | undefined;
}

export const usePortForwardStore = create<PortForwardState>()((set, get) => ({
  active: [],
  addActive: (active) =>
    set((state) => ({
      active: [
        ...state.active.filter((a) => a.connectionKey !== active.connectionKey),
        active,
      ],
    })),
  removeActive: (operationId) =>
    set((state) => ({
      active: state.active.filter((a) => a.operationId !== operationId),
    })),
  isActive: (connectionKey) => get().active.some((a) => a.connectionKey === connectionKey),
  findByConnection: (connectionKey) =>
    get().active.find((a) => a.connectionKey === connectionKey),
}));

export function buildConnectionKey(
  host: string,
  port: number,
  username: string,
): string {
  return `${username}@${host}:${port}`;
}

export async function startPortForwardsForProfile(
  profile: {
    host: string;
    port: number;
    username: string;
    authMethod: 'password' | 'key';
    password?: string;
    privateKeyPath?: string;
    passphrase?: string;
  },
  forwards: PortForwardConfig[],
): Promise<void> {
  const operationId = `pf-${profile.host}-${profile.port}-${Date.now()}`;
  await invokeStartPortForwards(
    operationId,
    profile.host,
    profile.port,
    profile.username,
    profile.authMethod,
    profile.password,
    profile.privateKeyPath,
    profile.passphrase,
    undefined,
    forwards,
  );
  usePortForwardStore
    .getState()
    .addActive({
      operationId,
      connectionKey: buildConnectionKey(profile.host, profile.port, profile.username),
      forwards,
    });
}

export async function stopPortForwardsForProfile(
  connectionKey: string,
): Promise<void> {
  const active = usePortForwardStore.getState().findByConnection(connectionKey);
  if (!active) return;
  await invokeStopPortForwards(active.operationId);
  usePortForwardStore.getState().removeActive(active.operationId);
}
