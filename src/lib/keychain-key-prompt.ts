import { useKeychainKeyPromptStore } from '@/stores/keychainKeyPromptStore';
import { useProfileStore } from '@/stores/profileStore';
import { useKeychainStore } from '@/stores/keychainStore';
import { createLogger } from '@/lib/logger';
import type { ConnectionProfile } from '@/types';

const logger = createLogger('keychain-key-prompt');

export type KeychainKeyPromptTarget = 'main' | 'jump';

function getPromptHost(profile: ConnectionProfile, target: KeychainKeyPromptTarget): {
  host: string;
  username: string;
} | null {
  if (target === 'jump') {
    if (!profile.jumpHost) return null;
    return {
      host: profile.jumpHost.host,
      username: profile.jumpHost.username,
    };
  }
  return {
    host: profile.host,
    username: profile.username,
  };
}

function keychainKeyExists(keyId: string): boolean {
  return useKeychainStore
    .getState()
    .keys.some((key) => key.id === keyId);
}

function getMissingKeychainKeyId(message: string): string | null {
  const normalized = message.toLowerCase();
  const prefix = 'keychain key not found:';
  if (!normalized.startsWith(prefix)) return null;
  return message.slice(prefix.length).trim() || null;
}

export function getMissingKeychainKeyTarget(
  profile: ConnectionProfile,
  message: string,
): KeychainKeyPromptTarget | null {
  const missingKeyId = getMissingKeychainKeyId(message);
  if (!missingKeyId) return null;
  if (profile.authMethod === 'key' && profile.keychainKeyId === missingKeyId) {
    return 'main';
  }
  if (
    profile.jumpHost?.authMethod === 'key' &&
    profile.jumpHost.keychainKeyId === missingKeyId
  ) {
    return 'jump';
  }
  return null;
}

/**
 * Prompts the user to recover a connection whose saved keychain key is missing.
 *
 * The user can select another saved key, or cancel. The target can be the main
 * host or a jump host; switching authentication methods is left to the profile
 * editor so this recovery path only updates the referenced key.
 *
 * @returns A copy of the profile with the chosen key, or null if cancelled.
 */
export async function promptForMissingKeychainKey(
  profile: ConnectionProfile,
  target: KeychainKeyPromptTarget = 'main',
): Promise<ConnectionProfile | null> {
  const promptHost = getPromptHost(profile, target);
  if (!promptHost) {
    logger.warn(`Cannot prompt for ${target} key: profile has no jump host`);
    return null;
  }

  logger.info(`Prompting for replacement ${target} key for ${promptHost.host}`);

  const result = await useKeychainKeyPromptStore.getState().requestKey({
    profileId: profile.id,
    host: promptHost.host,
    username: promptHost.username,
  });

  if (!result) {
    logger.info('Keychain key prompt cancelled by user');
    return null;
  }

  logger.info(`Updating profile ${profile.id} to use key ${result.keyId}`);
  if (target === 'jump') {
    if (!profile.jumpHost) return null;
    const jumpHost = {
      ...profile.jumpHost,
      keychainKeyId: result.keyId,
    };
    await useProfileStore.getState().updateProfile(profile.id, { jumpHost });
    return {
      ...profile,
      jumpHost,
    };
  }

  await useProfileStore.getState().updateProfile(profile.id, { keychainKeyId: result.keyId });
  return { ...profile, keychainKeyId: result.keyId };
}

/**
 * Ensures a profile that uses a key still references an existing key.
 *
 * If the referenced key is missing from the keychain store, the user is prompted
 * to select another key, and the profile is updated accordingly.
 *
 * @returns The same profile if no action is needed, an updated profile if the
 *          user chose a replacement, or null if the user cancelled.
 */
export async function ensureKeychainKeyForProfile(
  profile: ConnectionProfile,
): Promise<ConnectionProfile | null> {
  const hasMainKey = profile.authMethod === 'key' && !!profile.keychainKeyId;
  const hasJumpKey = profile.jumpHost?.authMethod === 'key' && !!profile.jumpHost.keychainKeyId;
  if (!hasMainKey && !hasJumpKey) {
    return profile;
  }

  const { initialized, hydrate } = useKeychainStore.getState();
  if (!initialized) {
    await hydrate();
  }
  const { loadError } = useKeychainStore.getState();
  if (loadError) {
    throw new Error(`failed to load keychain keys: ${loadError}`);
  }

  let preparedProfile = profile;
  if (
    preparedProfile.authMethod === 'key' &&
    preparedProfile.keychainKeyId &&
    !keychainKeyExists(preparedProfile.keychainKeyId)
  ) {
    const recovered = await promptForMissingKeychainKey(preparedProfile, 'main');
    if (!recovered) return null;
    preparedProfile = recovered;
  }

  if (
    preparedProfile.jumpHost?.authMethod === 'key' &&
    preparedProfile.jumpHost.keychainKeyId &&
    !keychainKeyExists(preparedProfile.jumpHost.keychainKeyId)
  ) {
    const recovered = await promptForMissingKeychainKey(preparedProfile, 'jump');
    if (!recovered) return null;
    preparedProfile = recovered;
  }

  return preparedProfile;
}
