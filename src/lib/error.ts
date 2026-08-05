import { t } from '@/locales';

const KEYCHAIN_KEY_NOT_FOUND_PREFIX = 'keychain key not found:';
const STORED_PASSWORD_MISSING_MESSAGE = 'stored password is missing';

/**
 * Extracts a human-readable message from an error value.
 *
 * Handles:
 * - JavaScript Error instances
 * - Structured Tauri command errors of the form `{ type: 'Other', payload: { message } }`
 * - Plain strings
 * - Generic objects (falls back to a JSON dump, never `[object Object]`)
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
    try {
      return JSON.stringify(error) ?? String(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

/**
 * Returns a human-readable message for an error, localizing common backend
 * messages for a better user experience.
 */
export function getLocalizedErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const typed = error as {
      type?: string;
      payload?: { host?: string; port?: number };
    };
    const { host, port } = typed.payload ?? {};
    if (typeof host === 'string' && typeof port === 'number') {
      if (typed.type === 'HostKeyUnknown') {
        return t('dialog.hostKeyUnknown.message', { host, port });
      }
      if (typed.type === 'HostKeyMismatch') {
        return t('dialog.hostKeyMismatch.message', { host, port });
      }
    }
  }

  const raw = getErrorMessage(error);
  if (raw.toLowerCase().startsWith(KEYCHAIN_KEY_NOT_FOUND_PREFIX)) {
    return t('error.keychainKeyNotFound');
  }
  if (raw.toLowerCase() === STORED_PASSWORD_MISSING_MESSAGE) {
    return t('error.storedPasswordMissing');
  }
  return raw;
}
