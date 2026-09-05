import { createLogger } from '@/lib/logger';
import { usePasswordPromptStore } from '@/stores/passwordPromptStore';
import { useToastStore } from '@/stores/toastStore';
import { invokeStoreProfilePassword } from '@/lib/ipc/tauri';
import { t } from '@/locales';
import type { ConnectionProfile } from '@/types';

const logger = createLogger('password-prompt');

/**
 * Ensures a password is available for the given profile.
 *
 * Profiles that already carry a password (loaded from the OS-level credential
 * store) are returned unchanged. Otherwise the user is prompted to enter one;
 * the entered password is only held in memory until it is persisted after a
 * successful connection (see
 * `persistPromptedPassword`).
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

/**
 * Persists a password that was entered via the connection-time prompt.
 *
 * Only passwords that actually came from the prompt are stored. If the
 * password was already loaded from the credential store, nothing is done.
 * This is best-effort: a keyring error cannot break an otherwise successful
 * connection.
 */
export async function persistPromptedPassword(
  original: ConnectionProfile,
  connected: ConnectionProfile,
): Promise<void> {
  if (
    connected.authMethod !== 'password' ||
    !connected.password ||
    connected.password === original.password
  ) {
    return;
  }

  try {
    await invokeStoreProfilePassword(original.id, connected.password);
    logger.info(`Stored prompted password for profile ${original.id}`);
  } catch (error) {
    logger.error(`Failed to store prompted password for profile ${original.id}`, error);
    useToastStore.getState().addToast(t('error.secretStoreFailed'), 'error');
  }
}
