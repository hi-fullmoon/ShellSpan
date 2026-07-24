import { createLogger } from '@/lib/logger';
import { usePasswordPromptStore } from '@/stores/passwordPromptStore';
import type { ConnectionProfile } from '@/types';

const logger = createLogger('password-prompt');

/**
 * Ensures a password is available for the given profile.
 *
 * Passwords are no longer persisted. If the profile does not already contain a
 * password, the user is prompted to enter one. The dialog does not offer a
 * "remember" option.
 *
 * @returns A copy of `profile` with `password` populated, or `null` if the
 *          user cancelled the dialog.
 */
export async function promptForMissingPassword(
  profile: ConnectionProfile,
): Promise<ConnectionProfile | null> {
  if (profile.password) {
    return profile;
  }

  if (profile.authMethod !== 'password') {
    return profile;
  }

  logger.info(`Prompting for password for ${profile.host}:${profile.port}`);
  const result = await usePasswordPromptStore
    .getState()
    .requestPassword({
      profileId: profile.id,
      host: profile.host,
      username: profile.username,
    });

  if (!result) {
    logger.info('Password prompt cancelled by user');
    return null;
  }

  return { ...profile, password: result.password };
}
