import { describe, it, expect } from 'vitest';
import { getErrorMessage, getLocalizedErrorMessage } from '../error';
import { t } from '@/locales';

describe('getErrorMessage', () => {
  it('returns message from Error instances', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns plain string errors as-is', () => {
    expect(getErrorMessage('plain error')).toBe('plain error');
  });

  it('extracts payload.message from structured Other errors', () => {
    expect(
      getErrorMessage({
        type: 'Other',
        payload: { message: 'keychain key not found: abc-123' },
      }),
    ).toBe('keychain key not found: abc-123');
  });

  it('extracts message from arbitrary objects', () => {
    expect(getErrorMessage({ message: 'object message' })).toBe('object message');
  });

  it('falls back to String() for unknown values', () => {
    expect(getErrorMessage(123)).toBe('123');
    expect(getErrorMessage(null)).toBe('null');
    expect(getErrorMessage(undefined)).toBe('undefined');
  });

  it('serializes message-less objects as JSON instead of [object Object]', () => {
    expect(
      getErrorMessage({ type: 'HostKeyMismatch', payload: { host: 'example.com', port: 22 } }),
    ).toBe('{"type":"HostKeyMismatch","payload":{"host":"example.com","port":22}}');
  });
});

describe('getLocalizedErrorMessage', () => {
  it('localizes structured host-key errors', () => {
    expect(
      getLocalizedErrorMessage({
        type: 'HostKeyUnknown',
        payload: { host: 'example.com', port: 22, fingerprint: 'SHA256:abc' },
      }),
    ).toBe(t('dialog.hostKeyUnknown.message', { host: 'example.com', port: 22 }));
    expect(
      getLocalizedErrorMessage({
        type: 'HostKeyMismatch',
        payload: { host: 'example.com', port: 22 },
      }),
    ).toBe(t('dialog.hostKeyMismatch.message', { host: 'example.com', port: 22 }));
  });

  it('localizes the stored-password-missing message', () => {
    expect(getLocalizedErrorMessage(new Error('Stored password is missing'))).toBe(
      t('error.storedPasswordMissing'),
    );
  });

  it('leaves unknown messages untouched', () => {
    expect(getLocalizedErrorMessage(new Error('something else'))).toBe('something else');
  });
});
