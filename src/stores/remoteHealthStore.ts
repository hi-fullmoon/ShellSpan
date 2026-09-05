import { create } from 'zustand';
import type {
  ConnectionProfile,
  RemoteHealthSnapshot,
  RemoteHealthSnapshotResult,
  RemoteHealthSource,
} from '@/types';
import {
  buildRemoteConnectionRequest,
  invokeCancelRemoteHealthSnapshot,
  invokeCollectRemoteHealthSnapshot,
} from '@/lib/ipc/tauri';
import { createOperationId } from '@/lib/operation-id';
import { getErrorMessage } from '@/lib/error';
import {
  remoteHealthResultMatchesProfile,
  REMOTE_HEALTH_TIMEOUT_MS,
} from '@/lib/host/remote-health';
import { promptForMissingPassword, persistPromptedPassword } from '@/lib/connections/password-prompt';
import { ensureKeychainKeyForProfile } from '@/lib/connections/keychain-key-prompt';
import { useProfileStore } from '@/stores/profileStore';
import { createLogger } from '@/lib/logger';

const logger = createLogger('remote-health');

export type RemoteHealthCollectionPhase = 'idle' | 'preparing' | 'collecting' | 'cancelling';

export interface RemoteHealthEntry {
  profileId: string;
  phase: RemoteHealthCollectionPhase;
  operationId?: string;
  snapshot?: RemoteHealthSnapshot;
  snapshotCheckedAt?: number;
  snapshotSource?: RemoteHealthSource;
  lastResult?: RemoteHealthSnapshotResult;
}

interface RemoteHealthState {
  selectedProfileId?: string;
  entries: Record<string, RemoteHealthEntry>;
  selectProfile: (profileId: string | undefined) => void;
  collect: (profile: ConnectionProfile, authorized: boolean) => Promise<RemoteHealthSnapshotResult>;
  cancel: (profileId: string) => Promise<void>;
  clear: (profileId?: string) => void;
}

function sourceFor(profile: ConnectionProfile): RemoteHealthSource {
  return {
    kind: 'sshReadOnly',
    commandSetVersion: 'shellspan-read-only-v1',
    profileId: profile.id,
    host: profile.host,
    port: profile.port,
    username: profile.username,
  };
}

function localResult(
  profile: ConnectionProfile,
  operationId: string,
  status: RemoteHealthSnapshotResult['status'],
  error: string,
): RemoteHealthSnapshotResult {
  return {
    operationId,
    profileId: profile.id,
    status,
    checkedAt: Date.now(),
    source: sourceFor(profile),
    error,
  };
}

function updateIfCurrent(
  set: (updater: (state: RemoteHealthState) => Partial<RemoteHealthState>) => void,
  profileId: string,
  operationId: string,
  updater: (entry: RemoteHealthEntry) => RemoteHealthEntry,
): void {
  set((state) => {
    const entry = state.entries[profileId];
    if (entry?.operationId !== operationId) return {};
    return { entries: { ...state.entries, [profileId]: updater(entry) } };
  });
}

export const useRemoteHealthStore = create<RemoteHealthState>()((set, get) => ({
  selectedProfileId: undefined,
  entries: {},

  selectProfile: (profileId) => set({ selectedProfileId: profileId }),

  collect: async (profile, authorized) => {
    const operationId = createOperationId('remote-health');
    const previous = get().entries[profile.id];
    set((state) => ({
      selectedProfileId: profile.id,
      entries: {
        ...state.entries,
        [profile.id]: {
          ...previous,
          profileId: profile.id,
          phase: 'preparing',
          operationId,
        },
      },
    }));

    if (!authorized) {
      const result = localResult(
        profile,
        operationId,
        'unauthorized',
        'remote health collection requires explicit user authorization',
      );
      updateIfCurrent(set, profile.id, operationId, (entry) => ({
        ...entry,
        phase: 'idle',
        operationId: undefined,
        lastResult: result,
      }));
      return result;
    }

    let profileWithSavedSecrets: ConnectionProfile | undefined;
    try {
      profileWithSavedSecrets = await useProfileStore.getState().ensurePassword(profile);
      const withPassword = await promptForMissingPassword(profileWithSavedSecrets);
      if (!withPassword) {
        const result = localResult(
          profile,
          operationId,
          'cancelled',
          'credential prompt was cancelled',
        );
        updateIfCurrent(set, profile.id, operationId, (entry) => ({
          ...entry,
          phase: 'idle',
          operationId: undefined,
          lastResult: result,
        }));
        return result;
      }
      const preparedProfile = await ensureKeychainKeyForProfile(withPassword);
      if (!preparedProfile) {
        const result = localResult(
          profile,
          operationId,
          'cancelled',
          'key credential prompt was cancelled',
        );
        updateIfCurrent(set, profile.id, operationId, (entry) => ({
          ...entry,
          phase: 'idle',
          operationId: undefined,
          lastResult: result,
        }));
        return result;
      }

      updateIfCurrent(set, profile.id, operationId, (entry) => ({ ...entry, phase: 'collecting' }));
      const result = await invokeCollectRemoteHealthSnapshot({
        operationId,
        profileId: profile.id,
        authorized: true,
        timeoutMs: REMOTE_HEALTH_TIMEOUT_MS,
        connection: buildRemoteConnectionRequest(preparedProfile),
      });
      if (
        result.operationId !== operationId
        || !remoteHealthResultMatchesProfile(profile, result)
      ) {
        throw new Error('remote health result profile identity mismatch');
      }
      if (result.status === 'success' && !result.snapshot) {
        throw new Error('remote health result is missing its snapshot');
      }
      if (result.status === 'success') {
        await persistPromptedPassword(profileWithSavedSecrets, preparedProfile);
      }
      updateIfCurrent(set, profile.id, operationId, (entry) => ({
        ...entry,
        phase: 'idle',
        operationId: undefined,
        lastResult: result,
        ...(result.snapshot
          ? {
              snapshot: result.snapshot,
              snapshotCheckedAt: result.checkedAt,
              snapshotSource: result.source,
            }
          : {}),
      }));
      return result;
    } catch (error) {
      const failed = localResult(profile, operationId, 'failed', getErrorMessage(error));
      updateIfCurrent(set, profile.id, operationId, (entry) => ({
        ...entry,
        phase: 'idle',
        operationId: undefined,
        lastResult: failed,
      }));
      logger.error(`Remote health collection failed for profile ${profile.id}`, error);
      return failed;
    }
  },

  cancel: async (profileId) => {
    const entry = get().entries[profileId];
    if (!entry?.operationId || entry.phase !== 'collecting') return;
    const operationId = entry.operationId;
    updateIfCurrent(set, profileId, operationId, (current) => ({
      ...current,
      phase: 'cancelling',
    }));
    try {
      await invokeCancelRemoteHealthSnapshot(operationId);
    } catch (error) {
      logger.warn(`Failed to cancel remote health operation ${operationId}`, error);
    }
  },

  clear: (profileId) => set((state) => {
    if (!profileId) return { entries: {}, selectedProfileId: undefined };
    const entries = { ...state.entries };
    delete entries[profileId];
    return {
      entries,
      selectedProfileId: state.selectedProfileId === profileId
        ? undefined
        : state.selectedProfileId,
    };
  }),
}));
