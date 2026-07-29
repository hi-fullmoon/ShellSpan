import { create } from 'zustand';
import type { AuthMethod, ConnectionProfile, JumpHostConfig, ProfileRow } from '@/types';
import {
  invokeListProfiles,
  invokeAddProfile,
  invokeUpdateProfile,
  invokeRemoveProfile,
  invokeRetrieveProfilePassword,
  invokeDeleteProfilePassword,
  invokeStoreProfilePassword,
} from '@/lib/tauri';
import { generateId } from '@/lib/utils';
import { useRecentProfilesStore } from './recentProfilesStore';
import { createLogger } from '@/lib/logger';

const logger = createLogger('profileStore');

interface ProfileState {
  profiles: ConnectionProfile[];
  initialized: boolean;
  hydrateFromDb: () => Promise<void>;
  addProfile: (profile: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>) => Promise<ConnectionProfile>;
  updateProfile: (
    id: string,
    updates: Partial<Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>>,
  ) => Promise<void>;
  removeProfile: (id: string) => Promise<void>;
  duplicateProfile: (id: string) => Promise<void>;
  getProfile: (id: string) => ConnectionProfile | undefined;
  ensurePassword: (profile: ConnectionProfile) => Promise<ConnectionProfile>;
  clearKeychainKeyIds: (profileIds: string[]) => void;
}

function profileToRow(profile: ConnectionProfile): ProfileRow {
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: profile.authMethod,
    keychainKeyId: profile.keychainKeyId,
    jumpHostConfig: profile.jumpHost ? JSON.stringify(profile.jumpHost) : undefined,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function rowToProfile(row: ProfileRow): ConnectionProfile {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authMethod: row.authMethod,
    keychainKeyId: row.keychainKeyId,
    jumpHost: row.jumpHostConfig ? JSON.parse(row.jumpHostConfig) : undefined,
    password: undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const useProfileStore = create<ProfileState>()((set, get) => ({
  profiles: [],
  initialized: false,

  hydrateFromDb: async () => {
    try {
      const rows = await invokeListProfiles();
      const profiles = await Promise.all(
        rows.map(async (row) => {
          const profile = rowToProfile(row);
          if (profile.authMethod === 'password') {
            try {
              profile.password = await invokeRetrieveProfilePassword(profile.id);
            } catch (error) {
              logger.error(`failed to retrieve password for profile ${profile.id}`, error);
              profile.password = undefined;
            }
          }
          return profile;
        }),
      );
      set({ profiles, initialized: true });
      logger.info(`loaded ${profiles.length} profiles from database`);
    } catch (error) {
      logger.error('failed to hydrate profiles from database', error);
      set({ initialized: true });
    }
  },

  addProfile: async (profile) => {
    const id = generateId();
    const now = Date.now();
    const password = profile.authMethod === 'password' ? profile.password : undefined;
    const newProfile: ConnectionProfile = {
      ...profile,
      password,
      id,
      createdAt: now,
      updatedAt: now,
    };
    await invokeAddProfile(profileToRow(newProfile));

    if (password) {
      try {
        await invokeStoreProfilePassword(id, password);
      } catch (error) {
        logger.error(`failed to store password for profile ${id}`, error);
      }
    }

    set((state) => ({
      profiles: [...state.profiles, newProfile],
    }));

    return newProfile;
  },

  updateProfile: async (id, updates) => {
    const current = get().profiles.find((p) => p.id === id);
    if (!current) return;

    const nextAuthMethod = updates.authMethod ?? current.authMethod;
    const passwordChanged =
      'password' in updates && (updates.password ?? '') !== (current.password ?? '');
    const needsNewPasswordKeychain = passwordChanged && nextAuthMethod === 'password';

    const updated: ConnectionProfile = {
      ...current,
      ...updates,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
      password: nextAuthMethod === 'password' ? updates.password ?? current.password : undefined,
      keychainKeyId: needsNewPasswordKeychain
        ? undefined
        : (updates.keychainKeyId ?? current.keychainKeyId),
    };

    await invokeUpdateProfile(id, profileToRow(updated));

    try {
      if (nextAuthMethod !== 'password' || passwordChanged) {
        await invokeDeleteProfilePassword(id);
      }
      if (nextAuthMethod === 'password' && passwordChanged && updates.password) {
        await invokeStoreProfilePassword(id, updates.password);
      }
    } catch (error) {
      logger.error(`failed to persist password for profile ${id}`, error);
    }

    set((state) => ({
      profiles: state.profiles.map((p) => (p.id === id ? updated : p)),
    }));
  },

  removeProfile: async (id) => {
    await invokeRemoveProfile(id);
    try {
      await invokeDeleteProfilePassword(id);
    } catch (error) {
      logger.error(`failed to delete stored password for profile ${id}`, error);
    }
    set((state) => ({
      profiles: state.profiles.filter((p) => p.id !== id),
    }));
    useRecentProfilesStore.getState().removeProfile(id);
  },

  duplicateProfile: async (id) => {
    const original = get().profiles.find((p) => p.id === id);
    if (!original) return;
    const {
      id: _id,
      name,
      createdAt,
      updatedAt,
      ...rest
    } = original;
    const duplicateId = generateId();
    const duplicate: ConnectionProfile = {
      ...rest,
      id: duplicateId,
      name: `${name} (copy)`,
      password: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await invokeAddProfile(profileToRow(duplicate));

    set((state) => ({
      profiles: [...state.profiles, duplicate],
    }));
  },

  getProfile: (id) => get().profiles.find((p) => p.id === id),

  ensurePassword: async (profile) => profile,

  clearKeychainKeyIds: (profileIds) => {
    if (profileIds.length === 0) return;
    const idSet = new Set(profileIds);
    const affected = get().profiles.filter((p) => idSet.has(p.id) && p.keychainKeyId);
    set((state) => ({
      profiles: state.profiles.map((p) =>
        idSet.has(p.id) ? { ...p, keychainKeyId: undefined } : p,
      ),
    }));
    // Persist the cleared references so dangling ids do not come back on the
    // next hydrate. update_profile overwrites the full row, so an undefined
    // keychainKeyId is stored as NULL.
    for (const profile of affected) {
      invokeUpdateProfile(profile.id, profileToRow({ ...profile, keychainKeyId: undefined })).catch(
        (error) =>
          logger.error(`failed to clear keychain key reference for profile ${profile.id}`, error),
      );
    }
  },
}));

export const DEFAULT_PROFILE_VALUES = {
  port: 22,
  authMethod: 'password' as AuthMethod,
};

export function createJumpHostConfig(
  values: Partial<JumpHostConfig>,
): JumpHostConfig {
  return {
    host: values.host ?? '',
    port: values.port ?? 22,
    username: values.username ?? '',
    authMethod: values.authMethod ?? 'password',
    password: values.password,
    keychainKeyId: values.keychainKeyId,
    passphrase: values.passphrase,
  };
}
