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
  removeStoredPassword: (id: string) => Promise<void>;
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
        return newProfile;
      },
      updateProfile: async (id, updates) => {
        const current = get().profiles.find((profile) => profile.id === id);
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

        set((state) => ({
          profiles: state.profiles.map((p) =>
            p.id === id
              ? {
                  ...p,
                  ...updates,
                  id: p.id,
                  createdAt: p.createdAt,
                  updatedAt: Date.now(),
                  password: undefined,
                  passwordStored,
                }
              : p,
          ),
        }));
      },
      removeProfile: async (id) => {
        await invokeRemovePassword(id);
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
