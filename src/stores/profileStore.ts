import { create } from 'zustand';
import type { AuthMethod, ConnectionProfile, JumpHostConfig, ProfileRow } from '@/types';
import {
  invokeListProfiles,
  invokeAddProfile,
  invokeUpdateProfile,
  invokeRemoveProfile,
  invokeStoreProfilePassword,
  invokeRetrieveProfilePassword,
  invokeDeleteProfilePassword,
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
    const passwordChanged = 'password' in updates;
    const nextPassword = passwordChanged ? updates.password : current.password;

    const updated: ConnectionProfile = {
      ...current,
      ...updates,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
      password: nextAuthMethod === 'password' ? nextPassword : undefined,
    };

    await invokeUpdateProfile(id, profileToRow(updated));

    try {
      if (nextAuthMethod !== 'password') {
        await invokeDeleteProfilePassword(id);
      } else if (passwordChanged) {
        if (nextPassword) {
          await invokeStoreProfilePassword(id, nextPassword);
        } else {
          await invokeDeleteProfilePassword(id);
        }
      }
    } catch (error) {
      logger.error(`failed to update stored password for profile ${id}`, error);
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
