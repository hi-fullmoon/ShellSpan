import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '../error';

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
});
