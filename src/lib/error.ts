import { t } from '@/locales';

const KEYCHAIN_KEY_NOT_FOUND_PREFIX = 'keychain key not found:';

/**
 * Extracts a human-readable message from an error value.
 *
 * Handles:
 * - JavaScript Error instances
 * - Structured Tauri command errors of the form `{ type: 'Other', payload: { message } }`
 * - Plain strings
 * - Generic objects (falls back to `String(value)`)
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (typeof error === 'object' && error !== null) {
    const typed = error as { type?: string; payload?: { message?: string } };
    if (typed.type === 'Other' && typed.payload?.message) {
      return typed.payload.message;
    }
    if ('message' in error && typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message;
    }
  }

  return String(error);
}

/**
 * Returns a human-readable message for an error, localizing common backend
 * messages for a better user experience.
 */
export function getLocalizedErrorMessage(error: unknown): string {
  const raw = getErrorMessage(error);
  if (raw.toLowerCase().startsWith(KEYCHAIN_KEY_NOT_FOUND_PREFIX)) {
    return t('error.keychainKeyNotFound');
  }
  return raw;
}
