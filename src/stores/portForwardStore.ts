import { create } from 'zustand';
import type {
  ConnectionProfile,
  PortForwardErrorCategory,
  PortForwardRule,
  PortForwardRuntime,
  PortForwardStartMode,
} from '@/types';
import {
  buildRemoteConnectionRequest,
  invokeListPortForwards,
  invokeStartPortForward,
  invokeStopAllPortForwards,
  invokeStopPortForward,
} from '@/lib/ipc/tauri';
import { createOperationId } from '@/lib/operation-id';
import { getErrorMessage } from '@/lib/error';
import { promptForMissingPassword } from '@/lib/connections/password-prompt';
import { ensureKeychainKeyForProfile } from '@/lib/connections/keychain-key-prompt';
import { useProfileStore } from '@/stores/profileStore';
import { useToastStore } from '@/stores/toastStore';
import { createLogger } from '@/lib/logger';
import { t } from '@/locales';

const logger = createLogger('port-forward');

export interface ManagedPortForwardRuntime extends PortForwardRuntime {
  ownerIds: string[];
}

export const ACTIVE_PORT_FORWARD_STATUSES = new Set<PortForwardRuntime['status']>([
  'starting',
  'running',
  'stopping',
]);

export function isPortForwardActive(runtime: PortForwardRuntime): boolean {
  return ACTIVE_PORT_FORWARD_STATUSES.has(runtime.status);
}

function classifyStartError(message: string): PortForwardErrorCategory {
  const normalized = message.toLowerCase();
  if (
    normalized.includes('already in use')
    || normalized.includes('address in use')
    || normalized.includes('failed to listen')
  ) return 'portInUse';
  if (normalized.includes('host key') || normalized.includes('known host')) return 'hostKey';
  if (normalized.includes('auth') || normalized.includes('credential')) return 'authentication';
  if (normalized.includes('invalid') || normalized.includes('must be')) return 'invalidConfiguration';
  if (
    normalized.includes('connect')
    || normalized.includes('resolve')
    || normalized.includes('handshake')
  ) return 'connection';
  return 'other';
}

function mergeRuntime(
  runtimes: ManagedPortForwardRuntime[],
  next: PortForwardRuntime,
): ManagedPortForwardRuntime[] {
  const previous = runtimes.find((runtime) => runtime.operationId === next.operationId);
  const merged: ManagedPortForwardRuntime = {
    ...next,
    ownerIds: previous?.ownerIds ?? [],
  };
  return previous
    ? runtimes.map((runtime) => runtime.operationId === next.operationId ? merged : runtime)
    : [merged, ...runtimes];
}

async function prepareManualProfile(
  profile: ConnectionProfile,
): Promise<ConnectionProfile | undefined> {
  const withSavedSecrets = await useProfileStore.getState().ensurePassword(profile);
  const withPassword = await promptForMissingPassword(withSavedSecrets);
  if (!withPassword) return undefined;
  return (await ensureKeychainKeyForProfile(withPassword)) ?? undefined;
}

interface PortForwardState {
  runtimes: ManagedPortForwardRuntime[];
  initialized: boolean;
  hydrate: () => Promise<void>;
  applyRuntime: (runtime: PortForwardRuntime) => void;
  startRule: (
    profile: ConnectionProfile,
    rule: PortForwardRule,
    mode: PortForwardStartMode,
    ownerId?: string,
    credentialsPrepared?: boolean,
  ) => Promise<ManagedPortForwardRuntime | undefined>;
  startAutoForOwner: (profile: ConnectionProfile, ownerId: string) => Promise<void>;
  stop: (operationId: string) => Promise<void>;
  stopOwner: (ownerId: string) => Promise<void>;
  stopOwnersByPrefix: (ownerPrefix: string) => Promise<void>;
  stopAll: () => Promise<void>;
  retry: (operationId: string) => Promise<void>;
  clearFinished: (profileId?: string) => void;
}

export const usePortForwardStore = create<PortForwardState>()((set, get) => ({
  runtimes: [],
  initialized: false,

  hydrate: async () => {
    try {
      const runtimes = await invokeListPortForwards();
      set((state) => ({
        initialized: true,
        runtimes: [
          ...runtimes.map((runtime) => ({
            ...runtime,
            ownerIds: state.runtimes.find((item) => item.operationId === runtime.operationId)
              ?.ownerIds ?? [],
          })),
          ...state.runtimes.filter((item) => !runtimes.some(
            (runtime) => runtime.operationId === item.operationId,
          )),
        ],
      }));
    } catch (error) {
      logger.error('Failed to hydrate port forward state', error);
      set({ initialized: true });
    }
  },

  applyRuntime: (runtime) => set((state) => ({
    runtimes: mergeRuntime(state.runtimes, runtime),
  })),

  startRule: async (profile, rule, mode, ownerId, credentialsPrepared = false) => {
    const stopping = get().runtimes.find((runtime) => (
      runtime.profileId === profile.id
      && runtime.configId === rule.id
      && runtime.status === 'stopping'
    ));
    if (stopping) {
      await waitForPortForwardEnd(stopping.operationId);
      return get().startRule(profile, rule, mode, ownerId, credentialsPrepared);
    }
    const active = get().runtimes.find((runtime) => (
      runtime.profileId === profile.id
      && runtime.configId === rule.id
      && isPortForwardActive(runtime)
    ));
    if (active) {
      if (ownerId && !active.ownerIds.includes(ownerId)) {
        set((state) => ({
          runtimes: state.runtimes.map((runtime) => runtime.operationId === active.operationId
            ? { ...runtime, ownerIds: [...runtime.ownerIds, ownerId] }
            : runtime),
        }));
      }
      return get().runtimes.find((runtime) => runtime.operationId === active.operationId);
    }

    const preparedProfile = credentialsPrepared
      ? profile
      : await prepareManualProfile(profile);
    if (!preparedProfile) return undefined;

    const operationId = createOperationId('port-forward');
    const optimistic: ManagedPortForwardRuntime = {
      operationId,
      profileId: profile.id,
      configId: rule.id,
      name: rule.name,
      kind: rule.kind,
      mode,
      status: 'starting',
      bytesSent: 0,
      bytesReceived: 0,
      ownerIds: ownerId ? [ownerId] : [],
    };
    set((state) => ({ runtimes: [optimistic, ...state.runtimes] }));

    try {
      const runtime = await invokeStartPortForward({
        operationId,
        profileId: profile.id,
        mode,
        connection: buildRemoteConnectionRequest(preparedProfile),
        forward: {
          id: rule.id,
          name: rule.name,
          kind: rule.kind,
          localPort: rule.localPort,
          remoteHost: rule.remoteHost,
          remotePort: rule.remotePort,
        },
      });
      get().applyRuntime(runtime);
      const managed = get().runtimes.find((item) => item.operationId === operationId);
      // A connection can close while the native start command is still in
      // flight. If its final owner disappeared during that race, stop the
      // newly registered listener immediately instead of orphaning it.
      if (managed?.mode === 'auto' && managed.ownerIds.length === 0) {
        await get().stop(operationId).catch(() => {});
      }
      return get().runtimes.find((item) => item.operationId === operationId);
    } catch (error) {
      const message = getErrorMessage(error);
      if (message.toLowerCase().includes('already active')) {
        set((state) => ({
          runtimes: state.runtimes.filter((runtime) => runtime.operationId !== operationId),
        }));
        await get().hydrate();
        const existing = get().runtimes.find((runtime) => (
          runtime.profileId === profile.id
          && runtime.configId === rule.id
          && (runtime.status === 'starting' || runtime.status === 'running')
        ));
        const stillStopping = get().runtimes.find((runtime) => (
          runtime.profileId === profile.id
          && runtime.configId === rule.id
          && runtime.status === 'stopping'
        ));
        if (!existing && stillStopping) {
          await waitForPortForwardEnd(stillStopping.operationId);
          return get().startRule(profile, rule, mode, ownerId, credentialsPrepared);
        }
        if (existing && ownerId && !existing.ownerIds.includes(ownerId)) {
          set((state) => ({
            runtimes: state.runtimes.map((runtime) => runtime.operationId === existing.operationId
              ? { ...runtime, ownerIds: [...runtime.ownerIds, ownerId] }
              : runtime),
          }));
        }
        return get().runtimes.find((runtime) => runtime.operationId === existing?.operationId);
      }
      const failed: PortForwardRuntime = {
        ...optimistic,
        status: 'failed',
        stoppedAt: Date.now(),
        lastError: message,
        errorCategory: classifyStartError(message),
      };
      get().applyRuntime(failed);
      useToastStore.getState().addToast(
        failed.errorCategory === 'portInUse'
          ? t('portForward.error.portInUse', { port: rule.localPort })
          : message,
        'error',
      );
      logger.error(`Failed to start port forward ${rule.id}`, error);
      return get().runtimes.find((item) => item.operationId === operationId);
    }
  },

  startAutoForOwner: async (profile, ownerId) => {
    for (const rule of profile.portForwards ?? []) {
      if (!rule.autoStart) continue;
      await get().startRule(profile, rule, 'auto', ownerId, true);
    }
  },

  stop: async (operationId) => {
    try {
      get().applyRuntime(await invokeStopPortForward(operationId));
    } catch (error) {
      logger.error(`Failed to stop port forward ${operationId}`, error);
      useToastStore.getState().addToast(getErrorMessage(error), 'error');
      throw error;
    }
  },

  stopOwner: async (ownerId) => {
    const owned = get().runtimes.filter((runtime) => runtime.ownerIds.includes(ownerId));
    for (const runtime of owned) {
      const remainingOwners = runtime.ownerIds.filter((id) => id !== ownerId);
      set((state) => ({
        runtimes: state.runtimes.map((item) => item.operationId === runtime.operationId
          ? { ...item, ownerIds: remainingOwners }
          : item),
      }));
      if (runtime.mode === 'auto' && remainingOwners.length === 0 && isPortForwardActive(runtime)) {
        await get().stop(runtime.operationId).catch(() => {});
      }
    }
  },

  stopOwnersByPrefix: async (ownerPrefix) => {
    const ownerIds = new Set(get().runtimes.flatMap((runtime) => (
      runtime.ownerIds.filter((ownerId) => ownerId.startsWith(ownerPrefix))
    )));
    for (const ownerId of ownerIds) {
      await get().stopOwner(ownerId);
    }
  },

  stopAll: async () => {
    try {
      const runtimes = await invokeStopAllPortForwards();
      runtimes.forEach((runtime) => get().applyRuntime(runtime));
    } catch (error) {
      logger.error('Failed to stop all port forwards', error);
      throw error;
    }
  },

  retry: async (operationId) => {
    const runtime = get().runtimes.find((item) => item.operationId === operationId);
    if (!runtime) return;
    const profile = useProfileStore.getState().getProfile(runtime.profileId);
    const rule = profile?.portForwards?.find((item) => item.id === runtime.configId);
    if (!profile || !rule) return;
    await get().startRule(profile, rule, 'manual');
  },

  clearFinished: (profileId) => set((state) => ({
    runtimes: state.runtimes.filter((runtime) => (
      isPortForwardActive(runtime)
      || (profileId !== undefined && runtime.profileId !== profileId)
    )),
  })),
}));

function waitForPortForwardEnd(operationId: string, timeoutMs = 5_000): Promise<void> {
  const current = usePortForwardStore
    .getState()
    .runtimes.find((runtime) => runtime.operationId === operationId);
  if (!current || !isPortForwardActive(current)) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const unsubscribe = usePortForwardStore.subscribe((state) => {
      const runtime = state.runtimes.find((item) => item.operationId === operationId);
      if (!runtime || !isPortForwardActive(runtime)) finish();
    });
    const timer = window.setTimeout(finish, timeoutMs);
  });
}
