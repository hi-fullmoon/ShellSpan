import { t } from '@/locales';

const KEYCHAIN_KEY_NOT_FOUND_PREFIX = 'keychain key not found:';
const STORED_PASSWORD_MISSING_MESSAGE = 'stored password is missing';

function containsAny(message: string, fragments: string[]): boolean {
  return fragments.some((fragment) => message.includes(fragment));
}

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
 * Returns a human-readable message for non-Toast error details, localizing
 * the backend cases that have a dedicated frontend message.
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

/**
 * Returns a concise, localized message suitable for an error Toast.
 *
 * Unlike getLocalizedErrorMessage, this never falls back to backend-provided
 * details. Callers should keep the original error in the application log.
 */
export function getToastErrorMessage(error: unknown): string {
  const localized = getLocalizedErrorMessage(error);
  const raw = getErrorMessage(error);
  if (localized !== raw) {
    return localized;
  }

  const normalized = raw.toLowerCase();
  if (
    containsAny(normalized, [
      'authentication failed',
      'auth failed',
      'invalid credentials',
      'password auth',
      'public key auth',
    ])
  ) {
    return t('error.authenticationFailed');
  }
  if (containsAny(normalized, ['timed out', 'timeout'])) {
    return t('error.connectionTimedOut');
  }
  if (
    containsAny(normalized, [
      'connection refused',
      'connection reset',
      'connection closed',
      'no route to host',
      'network is unreachable',
      'ssh handshake failed',
    ])
  ) {
    return t('error.connectionFailed');
  }
  if (
    containsAny(normalized, [
      'permission denied',
      'operation not permitted',
      'access denied',
    ])
  ) {
    return t('error.permissionDenied');
  }
  if (
    containsAny(normalized, [
      'no such file or directory',
      'no such file',
      'path does not exist',
      'file not found',
    ])
  ) {
    return t('error.pathNotFound');
  }
  if (containsAny(normalized, ['already exists', 'conflict'])) {
    return t('error.pathConflict');
  }
  if (containsAny(normalized, ['no space left', 'disk full'])) {
    return t('error.storageFull');
  }
  if (
    containsAny(normalized, [
      'failed to check the host key',
      'host key check failed',
      'failed to verify host key',
    ])
  ) {
    return t('error.hostKeyCheckFailed');
  }

  return t('error.operationFailed');
}
