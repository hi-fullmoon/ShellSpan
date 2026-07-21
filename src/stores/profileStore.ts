import { create } from 'zustand';
import type { AuthMethod, ConnectionProfile, JumpHostConfig, ProfileRow } from '@/types';
import {
  invokeRemovePassword,
  invokeRetrievePassword,
  invokeStorePassword,
  invokeListProfiles,
  invokeAddProfile,
  invokeUpdateProfile,
  invokeRemoveProfile,
} from '@/lib/tauri';
import { generateId, safeInvoke } from '@/lib/utils';
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
  removeStoredPassword: (id: string) => Promise<void>;
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
    passwordStored: profile.passwordStored ?? false,
    privateKeyPath: profile.privateKeyPath,
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
    passwordStored: row.passwordStored,
    privateKeyPath: row.privateKeyPath,
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
      const profiles = rows.map(rowToProfile);
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
    const passwordStored = Boolean(profile.password);
    if (profile.password) {
      await invokeStorePassword(id, profile.password);
    }
    const newProfile: ConnectionProfile = {
      ...profile,
      password: undefined,
      passwordStored,
      id,
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({
      profiles: [...state.profiles, newProfile],
    }));

    // Write-through to database (fire-and-forget)
    safeInvoke(invokeAddProfile, profileToRow(newProfile));

    return newProfile;
  },

  updateProfile: async (id, updates) => {
    const current = get().profiles.find((p) => p.id === id);
    if (!current) return;
    const password = updates.password;
    const nextAuthMethod = updates.authMethod ?? current.authMethod;
    let passwordStored = current.passwordStored ?? Boolean(current.password);

    if (password !== undefined) {
      if (password) {
        await invokeStorePassword(id, password);
        passwordStored = true;
      } else {
        await invokeRemovePassword(id);
        passwordStored = false;
      }
    } else if (nextAuthMethod !== 'password' && passwordStored) {
      await invokeRemovePassword(id);
      passwordStored = false;
    }

    const updated = {
      ...current,
      ...updates,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
      password: undefined,
      passwordStored,
    };

    set((state) => ({
      profiles: state.profiles.map((p) => (p.id === id ? updated : p)),
    }));

    // Write-through to database (fire-and-forget)
    safeInvoke(invokeUpdateProfile, id, profileToRow(updated));
  },

  removeProfile: async (id) => {
    await invokeRemovePassword(id);
    set((state) => ({
      profiles: state.profiles.filter((p) => p.id !== id),
    }));
    useRecentProfilesStore.getState().removeProfile(id);

    // Write-through to database (fire-and-forget)
    safeInvoke(invokeRemoveProfile, id);
  },

  duplicateProfile: async (id) => {
    const original = get().profiles.find((p) => p.id === id);
    if (!original) return;
    const {
      id: _id,
      name,
      createdAt,
      updatedAt,
      passwordStored: _passwordStored,
      ...rest
    } = original;
    const duplicateId = generateId();
    const password = await invokeRetrievePassword(id);
    if (password) {
      await invokeStorePassword(duplicateId, password);
    }
    const duplicate: ConnectionProfile = {
      ...rest,
      id: duplicateId,
      name: `${name} (copy)`,
      password: undefined,
      passwordStored: Boolean(password),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    set((state) => ({
      profiles: [...state.profiles, duplicate],
    }));

    // Write-through to database (fire-and-forget)
    safeInvoke(invokeAddProfile, profileToRow(duplicate));
  },

  removeStoredPassword: async (id) => {
    await invokeRemovePassword(id);
    set((state) => ({
      profiles: state.profiles.map((p) =>
        p.id === id
          ? { ...p, password: undefined, passwordStored: false }
          : p,
      ),
    }));
  },

  getProfile: (id) => get().profiles.find((p) => p.id === id),

  ensurePassword: async (profile) => {
    if (profile.authMethod === 'password' && !profile.password) {
      const password = await invokeRetrievePassword(profile.id);
      if (password) {
        set((state) => ({
          profiles: state.profiles.map((p) =>
            p.id === profile.id ? { ...p, passwordStored: true } : p,
          ),
        }));
        return { ...profile, password };
      }
      set((state) => ({
        profiles: state.profiles.map((p) =>
          p.id === profile.id ? { ...p, passwordStored: false } : p,
        ),
      }));
    }
    return profile;
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
    privateKeyPath: values.privateKeyPath,
    passphrase: values.passphrase,
  };
}
