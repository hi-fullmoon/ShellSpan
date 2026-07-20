import { invokeStorePassword } from '@/lib/tauri';
import { createLogger } from '@/lib/logger';
import { usePasswordPromptStore } from '@/stores/passwordPromptStore';
import { useProfileStore } from '@/stores/profileStore';
import type { ConnectionProfile } from '@/types';

const logger = createLogger('password-prompt');

/**
 * Ensures a password is available for the given profile.
 *
 * 1. Tries the system keychain via `ensurePassword`.
 * 2. If no password is found and the auth method is "password", shows a
 *    dialog prompting the user to enter one.
 * 3. If the user provides a password with the "remember" flag, stores it in
 *    the system keychain so future connections skip the prompt.
 *
 * @returns A copy of `profile` with `password` populated, or `null` if the
 *          user cancelled the dialog.
 */
export async function promptForMissingPassword(
  profile: ConnectionProfile,
): Promise<ConnectionProfile | null> {
  // Step 1: try system keychain
  let enriched = await useProfileStore.getState().ensurePassword(profile);
  const stored = profile.password || enriched.password;

  if (profile.authMethod === 'password' && !stored) {
    // Step 2: prompt the user
    logger.info(`Prompting for password for ${profile.host}:${profile.port}`);
    const result = await usePasswordPromptStore
      .getState()
      .requestPassword({
        profileId: profile.id,
        host: profile.host,
        username: profile.username,
      });

    if (!result) {
      // User cancelled the dialog — signal the caller to abort.
      logger.info('Password prompt cancelled by user');
      return null;
    }

    // Step 3: optionally persist to system keychain
    if (result.remember) {
      logger.info('Storing password in system keychain');
      await invokeStorePassword(profile.id, result.password).catch((error) => {
        logger.warn('Failed to store password in keychain', error);
      });
    }

    enriched = { ...enriched, password: result.password, passwordStored: result.remember || enriched.passwordStored };
  }

  return enriched;
}
