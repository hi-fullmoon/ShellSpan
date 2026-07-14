import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthMethod, ConnectionProfile, JumpHostConfig } from '@/types';
import {
  invokeRemovePassword,
  invokeRetrievePassword,
  invokeStorePassword,
} from '@/lib/tauri';
import { generateId } from '@/lib/utils';
import { useRecentProfilesStore } from './recentProfilesStore';

interface ProfileState {
  profiles: ConnectionProfile[];
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

const STORAGE_KEY = 'termbridge.profiles';

export const useProfileStore = create<ProfileState>()(
  persist(
    (set, get) => ({
      profiles: [],
      addProfile: async (profile) => {
        const id = generateId();
        const now = Date.now();
        const newProfile: ConnectionProfile = {
          ...profile,
          id,
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          profiles: [...state.profiles, newProfile],
        }));
        if (newProfile.password) {
          await invokeStorePassword(id, newProfile.password);
          set((state) => ({
            profiles: state.profiles.map((p) =>
              p.id === id ? { ...p, password: undefined } : p,
            ),
          }));
        }
        return get().profiles.find((p) => p.id === id)!;
      },
      updateProfile: async (id, updates) => {
        let password = updates.password;
        set((state) => ({
          profiles: state.profiles.map((p) =>
            p.id === id
              ? {
                  ...p,
                  ...updates,
                  id: p.id,
                  createdAt: p.createdAt,
                  updatedAt: Date.now(),
                  password:
                    password !== undefined ? undefined : p.password,
                }
              : p,
          ),
        }));
        if (password !== undefined) {
          if (password) {
            await invokeStorePassword(id, password);
          } else {
            await invokeRemovePassword(id);
          }
        }
      },
      removeProfile: async (id) => {
        set((state) => ({
          profiles: state.profiles.filter((p) => p.id !== id),
        }));
        await invokeRemovePassword(id);
        useRecentProfilesStore.getState().removeProfile(id);
      },
      duplicateProfile: async (id) => {
        const original = get().profiles.find((p) => p.id === id);
        if (!original) return;
        const { id: _id, name, createdAt, updatedAt, ...rest } = original;
        const duplicate: ConnectionProfile = {
          ...rest,
          id: generateId(),
          name: `${name} (copy)`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        set((state) => ({
          profiles: [...state.profiles, duplicate],
        }));
        const password = await invokeRetrievePassword(id);
        if (password) {
          await invokeStorePassword(duplicate.id, password);
        }
      },
      getProfile: (id) => get().profiles.find((p) => p.id === id),
      ensurePassword: async (profile) => {
        if (profile.authMethod === 'password' && !profile.password) {
          const password = await invokeRetrievePassword(profile.id);
          if (password) {
            return { ...profile, password };
          }
        }
        return profile;
      },
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({ profiles: state.profiles }),
    },
  ),
);

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
