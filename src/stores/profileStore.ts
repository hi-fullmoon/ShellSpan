import { create } from 'zustand';
import type { AuthMethod, ConnectionProfile, JumpHostConfig, ProfileRow, ProfileSecretKind } from '@/types';
import {
  invokeListProfiles,
  invokeAddProfile,
  invokeUpdateProfile,
  invokeRemoveProfile,
  invokeRetrieveProfilePassword,
  invokeDeleteProfilePassword,
  invokeStoreProfilePassword,
  invokeStoreProfileSecret,
  invokeRetrieveProfileSecret,
  invokeDeleteProfileSecret,
  invokeDeleteProfileSecrets,
} from '@/lib/tauri';
import { generateId } from '@/lib/utils';
import { useRecentProfilesStore } from './recentProfilesStore';
import { useToastStore } from './toastStore';
import { t } from '@/locales';
import { createLogger } from '@/lib/logger';

const logger = createLogger('profileStore');

/**
 * Per-profile secrets kept in the OS keychain (via `CredentialManager`),
 * derived from a profile's fields. Secrets are never written to the database;
 * `profileToRow` strips them before persisting.
 */
function profileSecrets(profile: ConnectionProfile): Record<ProfileSecretKind, string | undefined> {
  return {
    passphrase: profile.authMethod === 'key' ? profile.passphrase : undefined,
    'jump-password':
      profile.jumpHost?.authMethod === 'password' ? profile.jumpHost.password : undefined,
    'jump-passphrase':
      profile.jumpHost?.authMethod === 'key' ? profile.jumpHost.passphrase : undefined,
  };
}

function notifySecretPersistFailure(context: string, error: unknown): void {
  logger.error(context, error);
  useToastStore.getState().addToast(t('error.secretStoreFailed'), 'error');
}

/** Stores all of the profile's secrets in the keychain. Best-effort per secret. */
async function persistProfileSecrets(profile: ConnectionProfile): Promise<void> {
  const secrets = profileSecrets(profile);
  await Promise.all(
    (Object.entries(secrets) as [ProfileSecretKind, string | undefined][]).map(
      async ([kind, value]) => {
        if (!value) return;
        try {
          await invokeStoreProfileSecret(profile.id, kind, value);
        } catch (error) {
          notifySecretPersistFailure(`failed to store ${kind} for profile ${profile.id}`, error);
        }
      },
    ),
  );
}

/** Syncs secrets after an update: stores changed values, deletes cleared ones. */
async function syncProfileSecrets(
  previous: ConnectionProfile,
  next: ConnectionProfile,
): Promise<void> {
  const before = profileSecrets(previous);
  const after = profileSecrets(next);
  await Promise.all(
    (Object.keys(after) as ProfileSecretKind[]).map(async (kind) => {
      if ((before[kind] ?? '') === (after[kind] ?? '')) return;
      try {
        if (after[kind]) {
          await invokeStoreProfileSecret(next.id, kind, after[kind]);
        } else {
          await invokeDeleteProfileSecret(next.id, kind);
        }
      } catch (error) {
        notifySecretPersistFailure(`failed to sync ${kind} for profile ${next.id}`, error);
      }
    }),
  );
}

/** Loads the profile's secrets back from the keychain into the given profile. */
async function retrieveProfileSecrets(profile: ConnectionProfile): Promise<void> {
  const jobs: Promise<void>[] = [];
  if (profile.authMethod === 'key' && !profile.passphrase) {
    jobs.push(
      invokeRetrieveProfileSecret(profile.id, 'passphrase')
        .then((value) => {
          profile.passphrase = value;
        })
        .catch((error) =>
          logger.error(`failed to retrieve passphrase for profile ${profile.id}`, error),
        ),
    );
  }
  if (profile.jumpHost) {
    const jumpHost = profile.jumpHost;
    if (jumpHost.authMethod === 'password' && !jumpHost.password) {
      jobs.push(
        invokeRetrieveProfileSecret(profile.id, 'jump-password')
          .then((value) => {
            jumpHost.password = value;
          })
          .catch((error) =>
            logger.error(`failed to retrieve jump password for profile ${profile.id}`, error),
          ),
      );
    }
    if (jumpHost.authMethod === 'key' && !jumpHost.passphrase) {
      jobs.push(
        invokeRetrieveProfileSecret(profile.id, 'jump-passphrase')
          .then((value) => {
            jumpHost.passphrase = value;
          })
          .catch((error) =>
            logger.error(`failed to retrieve jump passphrase for profile ${profile.id}`, error),
          ),
      );
    }
  }
  await Promise.all(jobs);
}

/**
 * Moves plaintext jump-host secrets from legacy database rows into the
 * keychain and rewrites the row scrubbed. No-op for rows already clean.
 */
async function migrateLegacyJumpSecrets(profile: ConnectionProfile): Promise<void> {
  if (!profile.jumpHost) return;
  const hasPlaintext = Boolean(profile.jumpHost.password || profile.jumpHost.passphrase);
  if (!hasPlaintext) return;

  await persistProfileSecrets(profile);
  try {
    await invokeUpdateProfile(profile.id, profileToRow(profile));
    logger.info(`migrated plaintext jump-host secrets for profile ${profile.id} to keychain`);
  } catch (error) {
    logger.error(`failed to scrub jump-host secrets for profile ${profile.id}`, error);
  }
}

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
  // Secrets never go to the database — they live in the OS keychain.
  const scrubbedJumpHost = profile.jumpHost
    ? {
        ...profile.jumpHost,
        password: undefined,
        privateKeyData: undefined,
        passphrase: undefined,
      }
    : undefined;
  return {
    id: profile.id,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authMethod: profile.authMethod,
    keychainKeyId: profile.keychainKeyId,
    jumpHostConfig: scrubbedJumpHost ? JSON.stringify(scrubbedJumpHost) : undefined,
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
          // Legacy rows may still carry plaintext jump-host secrets; move them
          // to the keychain before filling in anything missing from there.
          await migrateLegacyJumpSecrets(profile);
          await retrieveProfileSecrets(profile);
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
        notifySecretPersistFailure(`failed to store password for profile ${id}`, error);
      }
    }
    await persistProfileSecrets(newProfile);

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
      notifySecretPersistFailure(`failed to persist password for profile ${id}`, error);
    }
    await syncProfileSecrets(current, updated);

    set((state) => ({
      profiles: state.profiles.map((p) => (p.id === id ? updated : p)),
    }));
  },

  removeProfile: async (id) => {
    await invokeRemoveProfile(id);
    try {
      await invokeDeleteProfileSecrets(id);
    } catch (error) {
      logger.error(`failed to delete stored secrets for profile ${id}`, error);
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

    // Carry over the original's keychain secrets so the copy connects
    // without re-entering credentials.
    try {
      const [password, passphrase, jumpPassword, jumpPassphrase] = await Promise.all([
        invokeRetrieveProfilePassword(id),
        invokeRetrieveProfileSecret(id, 'passphrase'),
        invokeRetrieveProfileSecret(id, 'jump-password'),
        invokeRetrieveProfileSecret(id, 'jump-passphrase'),
      ]);
      if (password) {
        await invokeStoreProfilePassword(duplicateId, password);
        duplicate.password = password;
      }
      const secretValues: [ProfileSecretKind, string | undefined][] = [
        ['passphrase', passphrase],
        ['jump-password', jumpPassword],
        ['jump-passphrase', jumpPassphrase],
      ];
      for (const [kind, value] of secretValues) {
        if (value) {
          await invokeStoreProfileSecret(duplicateId, kind, value);
        }
      }
    } catch (error) {
      notifySecretPersistFailure(`failed to copy secrets for duplicated profile ${duplicateId}`, error);
    }

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
