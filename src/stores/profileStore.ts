import { create } from 'zustand';
import type {
  AuthMethod,
  ConnectionProfile,
  JumpHostConfig,
  PortForwardKind,
  PortForwardRule,
  ProfileRow,
  ProfileSecretKind,
} from '@/types';
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
import { sanitizeHostQuickActions } from '@/lib/host-quick-action-model';

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

function scrubInMemorySecrets(profile: ConnectionProfile): ConnectionProfile {
  return {
    ...profile,
    password: undefined,
    passphrase: undefined,
    jumpHost: profile.jumpHost
      ? {
          ...profile.jumpHost,
          password: undefined,
          privateKeyData: undefined,
          passphrase: undefined,
        }
      : undefined,
  };
}

function notifySecretPersistFailure(context: string, error: unknown): void {
  logger.error(context, error);
  useToastStore.getState().addToast(t('error.secretStoreFailed'), 'error');
}

async function rollbackProfileCreation(profileId: string): Promise<void> {
  try {
    await invokeDeleteProfileSecrets(profileId);
  } catch (error) {
    logger.error(`failed to roll back secrets for profile ${profileId}`, error);
  }
  try {
    await invokeRemoveProfile(profileId);
  } catch (error) {
    logger.error(`failed to roll back metadata for profile ${profileId}`, error);
  }
}

/** Stores all of the profile's secrets in the keychain. */
async function persistProfileSecrets(profile: ConnectionProfile): Promise<void> {
  const secrets = profileSecrets(profile);
  for (const [kind, value] of Object.entries(secrets) as [ProfileSecretKind, string | undefined][]) {
    if (!value) continue;
    await invokeStoreProfileSecret(profile.id, kind, value);
  }
}

interface ProfileSecretMutation {
  description: string;
  desiredValue?: string;
  force?: boolean;
  read: () => Promise<string | undefined>;
  store: (value: string) => Promise<void>;
  remove: () => Promise<void>;
}

interface AppliedProfileSecretMutation extends ProfileSecretMutation {
  previousValue?: string;
}

async function rollbackSecretMutations(
  profileId: string,
  applied: AppliedProfileSecretMutation[],
): Promise<void> {
  for (const mutation of [...applied].reverse()) {
    try {
      if (mutation.previousValue) {
        await mutation.store(mutation.previousValue);
      } else {
        await mutation.remove();
      }
    } catch (error) {
      logger.error(
        `failed to roll back ${mutation.description} for profile ${profileId}`,
        error,
      );
    }
  }
}

/** Syncs secrets after an update and rolls back completed mutations on failure. */
async function syncProfileSecrets(
  previous: ConnectionProfile,
  next: ConnectionProfile,
  passwordChanged: boolean,
): Promise<void> {
  const before = profileSecrets(previous);
  const after = profileSecrets(next);
  const mutations: ProfileSecretMutation[] = [];

  if (previous.authMethod === 'password' && next.authMethod !== 'password') {
    mutations.push({
      description: 'password',
      desiredValue: undefined,
      force: true,
      read: () => invokeRetrieveProfilePassword(next.id),
      store: (value) => invokeStoreProfilePassword(next.id, value),
      remove: () => invokeDeleteProfilePassword(next.id),
    });
  } else if (next.authMethod === 'password' && passwordChanged) {
    mutations.push({
      description: 'password',
      desiredValue: next.password,
      read: () => invokeRetrieveProfilePassword(next.id),
      store: (value) => invokeStoreProfilePassword(next.id, value),
      remove: () => invokeDeleteProfilePassword(next.id),
    });
  }

  const shouldDeleteForAuthChange = (kind: ProfileSecretKind): boolean => {
    if (kind === 'passphrase') {
      return previous.authMethod === 'key' && next.authMethod !== 'key';
    }
    if (kind === 'jump-password') {
      return previous.jumpHost?.authMethod === 'password' && next.jumpHost?.authMethod !== 'password';
    }
    return previous.jumpHost?.authMethod === 'key' && next.jumpHost?.authMethod !== 'key';
  };

  for (const kind of Object.keys(after) as ProfileSecretKind[]) {
    const beforeValue = before[kind];
    const afterValue = after[kind];
    if ((beforeValue ?? '') === (afterValue ?? '') && !shouldDeleteForAuthChange(kind)) continue;
    mutations.push({
      description: kind,
      desiredValue: afterValue,
      force: shouldDeleteForAuthChange(kind),
      read: () => invokeRetrieveProfileSecret(next.id, kind),
      store: (value) => invokeStoreProfileSecret(next.id, kind, value),
      remove: () => invokeDeleteProfileSecret(next.id, kind),
    });
  }

  const applied: AppliedProfileSecretMutation[] = [];
  try {
    for (const mutation of mutations) {
      const previousValue = await mutation.read();
      if (!mutation.force && (previousValue ?? '') === (mutation.desiredValue ?? '')) continue;
      if (mutation.desiredValue) {
        await mutation.store(mutation.desiredValue);
      } else {
        await mutation.remove();
      }
      applied.push({ ...mutation, previousValue });
    }
  } catch (error) {
    await rollbackSecretMutations(next.id, applied);
    notifySecretPersistFailure(`failed to sync secrets for profile ${next.id}`, error);
    throw error;
  }
}

/** Loads the profile's secrets back from the keychain into a profile copy. */
async function retrieveProfileSecrets(profile: ConnectionProfile): Promise<ConnectionProfile> {
  const hydrated: ConnectionProfile = {
    ...profile,
    jumpHost: profile.jumpHost ? { ...profile.jumpHost } : undefined,
  };
  const jobs: Promise<void>[] = [];
  if (hydrated.authMethod === 'key' && !hydrated.passphrase) {
    jobs.push(
      invokeRetrieveProfileSecret(hydrated.id, 'passphrase')
        .then((value) => {
          hydrated.passphrase = value;
        })
        .catch((error) =>
          logger.error(`failed to retrieve passphrase for profile ${hydrated.id}`, error),
        ),
    );
  }
  if (hydrated.jumpHost) {
    const jumpHost = hydrated.jumpHost;
    if (jumpHost.authMethod === 'password' && !jumpHost.password) {
      jobs.push(
        invokeRetrieveProfileSecret(hydrated.id, 'jump-password')
          .then((value) => {
            jumpHost.password = value;
          })
          .catch((error) =>
            logger.error(`failed to retrieve jump password for profile ${hydrated.id}`, error),
          ),
      );
    }
    if (jumpHost.authMethod === 'key' && !jumpHost.passphrase) {
      jobs.push(
        invokeRetrieveProfileSecret(hydrated.id, 'jump-passphrase')
          .then((value) => {
            jumpHost.passphrase = value;
          })
          .catch((error) =>
            logger.error(`failed to retrieve jump passphrase for profile ${hydrated.id}`, error),
          ),
      );
    }
  }
  await Promise.all(jobs);
  return hydrated;
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
  clearKeychainKeyIds: (profileIds: string[], keyId?: string, persist?: boolean) => void;
  clearProfilePassword: (profileId: string) => void;
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
    organizationJson: JSON.stringify({
      group: profile.group?.trim() || undefined,
      tags: [...new Set((profile.tags ?? []).map((tag) => tag.trim()).filter(Boolean))],
      favorite: Boolean(profile.favorite),
      notes: profile.notes?.trim() || undefined,
      portForwards: sanitizePortForwardRules(profile.portForwards),
      quickActions: sanitizeHostQuickActions(profile.quickActions),
    }),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function parseOrganizationMetadata(value: string | undefined): Pick<
  ConnectionProfile,
  'group' | 'tags' | 'favorite' | 'notes' | 'portForwards' | 'quickActions'
> {
  if (!value) return { tags: [], favorite: false, portForwards: [], quickActions: [] };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      group: typeof parsed.group === 'string' && parsed.group.trim()
        ? parsed.group.trim()
        : undefined,
      tags: Array.isArray(parsed.tags)
        ? [...new Set(parsed.tags.filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim()).filter(Boolean))]
        : [],
      favorite: parsed.favorite === true,
      notes: typeof parsed.notes === 'string' && parsed.notes.trim()
        ? parsed.notes.trim()
        : undefined,
      portForwards: sanitizePortForwardRules(parsed.portForwards),
      quickActions: sanitizeHostQuickActions(parsed.quickActions),
    };
  } catch (error) {
    logger.error('ignored invalid profile organization metadata', error);
    return { tags: [], favorite: false, portForwards: [], quickActions: [] };
  }
}

function sanitizePortForwardRules(value: unknown): PortForwardRule[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const rules: PortForwardRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    const kind: PortForwardKind | undefined = candidate.kind === 'local' || candidate.kind === 'remote'
      ? candidate.kind
      : undefined;
    const localPort = Number(candidate.localPort);
    const remotePort = Number(candidate.remotePort);
    const remoteHost = typeof candidate.remoteHost === 'string'
      ? candidate.remoteHost.trim()
      : '';
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)
      || seen.has(id)
      || !name
      || name.length > 100
      || /[\u0000-\u001f\u007f]/.test(name)
      || !kind
      || !remoteHost
      || !Number.isInteger(localPort)
      || localPort < 1
      || localPort > 65_535
      || !Number.isInteger(remotePort)
      || remotePort < 1
      || remotePort > 65_535
      || (kind === 'remote' && !['127.0.0.1', 'localhost', '::1'].includes(remoteHost))
    ) continue;
    seen.add(id);
    rules.push({
      id,
      name,
      kind,
      localPort,
      remoteHost,
      remotePort,
      autoStart: candidate.autoStart === true,
    });
  }
  return rules;
}

async function retrieveProfilePassword(profile: ConnectionProfile): Promise<ConnectionProfile> {
  if (profile.authMethod !== 'password' || profile.password) {
    return profile;
  }
  try {
    return {
      ...profile,
      password: await invokeRetrieveProfilePassword(profile.id),
    };
  } catch (error) {
    logger.error(`failed to retrieve password for profile ${profile.id}`, error);
    return {
      ...profile,
      password: undefined,
    };
  }
}

async function prepareProfileSecrets(profile: ConnectionProfile): Promise<ConnectionProfile> {
  return retrieveProfileSecrets(await retrieveProfilePassword(profile));
}

function rowToProfile(row: ProfileRow): ConnectionProfile {
  const storedJumpHost: JumpHostConfig | undefined = row.jumpHostConfig
    ? JSON.parse(row.jumpHostConfig)
    : undefined;
  const jumpHost = storedJumpHost
    ? {
        ...storedJumpHost,
        password: undefined,
        privateKeyData: undefined,
        passphrase: undefined,
      }
    : undefined;
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authMethod: row.authMethod,
    keychainKeyId: row.keychainKeyId,
    jumpHost,
    password: undefined,
    ...parseOrganizationMetadata(row.organizationJson),
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
    const password = profile.authMethod === 'password' ? profile.password : undefined;
    const newProfile: ConnectionProfile = {
      ...profile,
      password,
      id,
      createdAt: now,
      updatedAt: now,
    };
    await invokeAddProfile(profileToRow(newProfile));

    try {
      if (password) {
        await invokeStoreProfilePassword(id, password);
      }
      await persistProfileSecrets(newProfile);
    } catch (error) {
      notifySecretPersistFailure(`failed to persist credentials for profile ${id}`, error);
      await rollbackProfileCreation(id);
      throw error;
    }

    set((state) => ({
      profiles: [...state.profiles, scrubInMemorySecrets(newProfile)],
    }));

    return newProfile;
  },

  updateProfile: async (id, updates) => {
    const current = get().profiles.find((p) => p.id === id);
    if (!current) return;

    const nextAuthMethod = updates.authMethod ?? current.authMethod;
    const passwordChanged =
      'password' in updates && (updates.password ?? '') !== (current.password ?? '');
    const updated: ConnectionProfile = {
      ...current,
      ...updates,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
      password: nextAuthMethod === 'password' ? updates.password ?? current.password : undefined,
      keychainKeyId:
        nextAuthMethod === 'key' ? updates.keychainKeyId ?? current.keychainKeyId : undefined,
    };

    await invokeUpdateProfile(id, profileToRow(updated));

    try {
      await syncProfileSecrets(current, updated, passwordChanged);
    } catch (error) {
      try {
        await invokeUpdateProfile(id, profileToRow(current));
      } catch (rollbackError) {
        logger.error(`failed to roll back profile metadata ${id}`, rollbackError);
      }
      throw error;
    }

    set((state) => ({
      profiles: state.profiles.map((p) => (p.id === id ? scrubInMemorySecrets(updated) : p)),
    }));
  },

  removeProfile: async (id) => {
    // Fail closed: do not remove the profile metadata while native credentials
    // may still exist and become invisible orphan entries.
    await invokeDeleteProfileSecrets(id);
    await invokeRemoveProfile(id);
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
      await rollbackProfileCreation(duplicateId);
      throw error;
    }

    set((state) => ({
      profiles: [...state.profiles, scrubInMemorySecrets(duplicate)],
    }));
  },

  getProfile: (id) => get().profiles.find((p) => p.id === id),

  ensurePassword: async (profile) => {
    const current = get().profiles.find((p) => p.id === profile.id) ?? profile;
    return prepareProfileSecrets(current);
  },

  clearKeychainKeyIds: (profileIds, keyId, persist = true) => {
    if (profileIds.length === 0) return;
    const idSet = new Set(profileIds);
    const affected = get().profiles.filter((profile) => idSet.has(profile.id));
    const clearReferences = (profile: ConnectionProfile): ConnectionProfile => ({
      ...profile,
      keychainKeyId:
        !keyId || profile.keychainKeyId === keyId ? undefined : profile.keychainKeyId,
      jumpHost: profile.jumpHost
        ? {
            ...profile.jumpHost,
            keychainKeyId:
              keyId && profile.jumpHost.keychainKeyId === keyId
                ? undefined
                : profile.jumpHost.keychainKeyId,
          }
        : undefined,
    });
    set((state) => ({
      profiles: state.profiles.map((p) =>
        idSet.has(p.id) ? clearReferences(p) : p,
      ),
    }));
    // Persist the cleared references so dangling ids do not come back on the
    // next hydrate. update_profile overwrites the full row, so an undefined
    // keychainKeyId is stored as NULL.
    if (!persist) return;
    for (const profile of affected) {
      const cleared = clearReferences(profile);
      invokeUpdateProfile(profile.id, profileToRow(cleared)).catch(
        (error) =>
          logger.error(`failed to clear keychain key reference for profile ${profile.id}`, error),
      );
    }
  },

  clearProfilePassword: (profileId) => {
    set((state) => ({
      profiles: state.profiles.map((profile) =>
        profile.id === profileId ? { ...profile, password: undefined } : profile,
      ),
    }));
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
