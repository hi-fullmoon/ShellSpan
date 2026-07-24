import { useKeychainKeyPromptStore } from '@/stores/keychainKeyPromptStore';
import { useProfileStore } from '@/stores/profileStore';
import { useKeychainStore } from '@/stores/keychainStore';
import { createLogger } from '@/lib/logger';
import type { ConnectionProfile } from '@/types';

const logger = createLogger('keychain-key-prompt');

/**
 * Prompts the user to recover a connection whose saved keychain key is missing.
 *
 * The user can select another saved key, or cancel. Unlike the previous flow,
 * switching to password authentication is no longer offered because the profile
 * authentication method is fixed to "key".
 *
 * @returns A copy of the profile with the chosen key, or null if cancelled.
 */
export async function promptForMissingKeychainKey(
  profile: ConnectionProfile,
): Promise<ConnectionProfile | null> {
  logger.info(`Prompting for replacement key for ${profile.host}:${profile.port}`);

  const result = await useKeychainKeyPromptStore.getState().requestKey({
    profileId: profile.id,
    host: profile.host,
    username: profile.username,
  });

  if (!result) {
    logger.info('Keychain key prompt cancelled by user');
    return null;
  }

  logger.info(`Updating profile ${profile.id} to use key ${result.keyId}`);
  await useProfileStore.getState().updateProfile(profile.id, {
    keychainKeyId: result.keyId,
  });
  return {
    ...profile,
    keychainKeyId: result.keyId,
  };
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
  if (profile.authMethod !== 'key' || !profile.keychainKeyId) {
    return profile;
  }

  const { initialized, hydrate } = useKeychainStore.getState();
  if (!initialized) {
    await hydrate();
  }

  const keyExists = useKeychainStore
    .getState()
    .keys.some((key) => key.id === profile.keychainKeyId);
  if (keyExists) {
    return profile;
  }

  return promptForMissingKeychainKey(profile);
}

/**
 * Prepares a profile that uses a keychain key for connection.
 *
 * Password-derived ECDSA keys now store the derived private key in the
 * keychain, so no extra prompt is required. Key file keys are also returned
 * unchanged. This function still ensures the referenced key exists.
 *
 * @returns The same profile if no action is needed, or null if the user
 *          cancelled the replacement prompt.
 */
export async function prepareKeychainKeyForProfile(
  profile: ConnectionProfile,
): Promise<ConnectionProfile | null> {
  if (profile.authMethod !== 'key' || !profile.keychainKeyId) {
    return profile;
  }

  const { initialized, hydrate, getKey } = useKeychainStore.getState();
  if (!initialized) {
    await hydrate();
  }

  let key = await getKey(profile.keychainKeyId);
  if (!key) {
    const recovered = await promptForMissingKeychainKey(profile);
    if (!recovered) {
      return null;
    }
    if (!recovered.keychainKeyId) {
      return null;
    }
    key = await getKey(recovered.keychainKeyId);
    if (!key) {
      return null;
    }
    profile = recovered;
  }

  return profile;
}
