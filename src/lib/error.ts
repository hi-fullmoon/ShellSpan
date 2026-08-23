import { t, type LocaleKey } from '@/locales';

const KEYCHAIN_KEY_NOT_FOUND_PREFIX = 'keychain key not found:';
const STORED_PASSWORD_MISSING_MESSAGE = 'stored password is missing';

function containsAny(message: string, fragments: string[]): boolean {
  return fragments.some((fragment) => message.includes(fragment));
}

export type ErrorCategory =
  | 'authentication'
  | 'timeout'
  | 'network'
  | 'permission'
  | 'not-found'
  | 'conflict'
  | 'storage'
  | 'host-key'
  | 'cancelled'
  | 'unknown';

export interface ErrorClassification {
  category: ErrorCategory;
  retryable: boolean;
  messageKey: LocaleKey;
}

/** Maps unstable platform/library messages to a stable UI and audit taxonomy. */
export function classifyError(error: unknown): ErrorClassification {
  if (typeof error === 'object' && error !== null) {
    const type = (error as { type?: unknown }).type;
    if (type === 'HostKeyUnknown' || type === 'HostKeyMismatch') {
      return { category: 'host-key', retryable: false, messageKey: 'error.hostKeyCheckFailed' };
    }
  }

  const normalized = getErrorMessage(error).toLowerCase();
  if (containsAny(normalized, ['cancelled', 'canceled', 'operation aborted'])) {
    return { category: 'cancelled', retryable: true, messageKey: 'error.operationCancelled' };
  }
  if (
    containsAny(normalized, [
      'authentication failed', 'auth failed', 'invalid credentials',
      'password auth', 'public key auth', KEYCHAIN_KEY_NOT_FOUND_PREFIX,
      STORED_PASSWORD_MISSING_MESSAGE,
    ])
  ) {
    return { category: 'authentication', retryable: false, messageKey: 'error.authenticationFailed' };
  }
  if (containsAny(normalized, ['timed out', 'timeout'])) {
    return { category: 'timeout', retryable: true, messageKey: 'error.connectionTimedOut' };
  }
  if (
    containsAny(normalized, [
      'connection refused', 'connection reset', 'connection closed',
      'broken pipe', 'no route to host', 'network is unreachable',
      'ssh handshake failed', 'transport disconnected',
    ])
  ) {
    return { category: 'network', retryable: true, messageKey: 'error.connectionFailed' };
  }
  if (containsAny(normalized, ['permission denied', 'operation not permitted', 'access denied'])) {
    return { category: 'permission', retryable: false, messageKey: 'error.permissionDenied' };
  }
  if (containsAny(normalized, ['no such file or directory', 'no such file', 'path does not exist', 'file not found'])) {
    return { category: 'not-found', retryable: false, messageKey: 'error.pathNotFound' };
  }
  if (containsAny(normalized, ['already exists', 'conflict'])) {
    return { category: 'conflict', retryable: false, messageKey: 'error.pathConflict' };
  }
  if (containsAny(normalized, ['no space left', 'disk full'])) {
    return { category: 'storage', retryable: true, messageKey: 'error.storageFull' };
  }
  if (containsAny(normalized, ['failed to check the host key', 'host key check failed', 'failed to verify host key'])) {
    return { category: 'host-key', retryable: true, messageKey: 'error.hostKeyCheckFailed' };
  }
  return { category: 'unknown', retryable: true, messageKey: 'error.operationFailed' };
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

  return t(classifyError(error).messageKey);
}
