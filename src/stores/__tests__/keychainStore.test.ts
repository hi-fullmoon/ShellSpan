import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useKeychainStore, detectKeyType } from '../keychainStore';

const { invokeListKeyCredentials, invokeStoreKeyCredential, invokeRetrieveKeyCredential, invokeDeleteKeyCredential } = vi.hoisted(() => ({
  invokeListKeyCredentials: vi.fn(),
  invokeStoreKeyCredential: vi.fn(),
  invokeRetrieveKeyCredential: vi.fn(),
  invokeDeleteKeyCredential: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  invokeListKeyCredentials,
  invokeStoreKeyCredential,
  invokeRetrieveKeyCredential,
  invokeDeleteKeyCredential,
}));

const PKCS8_ECDSA_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg54Gkuxt07x1huApu
z5Rv0Fnh98/LDwMm/sRRiNk8LZmhRANCAARIRvp+RcyGU0dbzVxShJj9giaWtN8C
80Zl+c2ON5rHOmYeEwpuJrDEg8NIdbQrK2uEk6vENsr8V2phglkdHImH
-----END PRIVATE KEY-----`;

const SEC1_ECDSA_KEY = `-----BEGIN EC PRIVATE KEY-----
MGsCAQEEIOeBpLsbdO8dYbgKbs+Ub9BZ4ffPyw8DJv7EUYjZPC2ZoUQDQgAESEb6
fkXMhlNHW81cUoSY/YImlrTfAvNGZfnNjjeaxzpmHhMKbiawxIPDSHW0KytrhJOr
xDbK/FdqYYJZHRyJhw==
-----END EC PRIVATE KEY-----`;

const OPENSSH_ED25519_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAVxSp3Sb/nhYTQq4WYxFjIPe02uerD0B3Beu+au0BXgQAAAIjawYpn2sGK
ZwAAAAtzc2gtZWQyNTUxOQAAACAVxSp3Sb/nhYTQq4WYxFjIPe02uerD0B3Beu+au0BXgQ
AAAEA0IQmo0munwXwrlfo6OY3ZjiAPAHWYaEEgW8SS4M99jxXFKndJv+eFhNCrhZjEWMg9
7Ta56sPQHcF675q7QFeBAAAABHRlc3QB
-----END OPENSSH PRIVATE KEY-----`;

const RSA_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAJBALRiMLAHckoWcpcLlS4cL2lxdJ9DpMK6gvor0nG9mKDhpbCSHH4F
-----END RSA PRIVATE KEY-----`;

describe('detectKeyType', () => {
  it('detects PKCS#8 ECDSA keys', () => {
    expect(detectKeyType(PKCS8_ECDSA_KEY)).toBe('ecdsa');
  });

  it('detects SEC1 ECDSA keys', () => {
    expect(detectKeyType(SEC1_ECDSA_KEY)).toBe('ecdsa');
  });

  it('detects OpenSSH ed25519 keys', () => {
    expect(detectKeyType(OPENSSH_ED25519_KEY)).toBe('ed25519');
  });

  it('detects RSA keys', () => {
    expect(detectKeyType(RSA_KEY)).toBe('rsa');
  });

  it('returns unknown for unrecognized keys', () => {
    expect(detectKeyType('not a key')).toBe('unknown');
  });

  it('returns unknown for PKCS#8 keys without a recognized algorithm', () => {
    expect(detectKeyType('-----BEGIN PRIVATE KEY-----\nMIIBBQIBAD==\n-----END PRIVATE KEY-----')).toBe('unknown');
  });
});

describe('keychainStore hydrate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useKeychainStore.setState({ keys: [], initialized: false });
  });

  it('maps password-kind credentials to ecdsa key type on hydrate', async () => {
    invokeListKeyCredentials.mockResolvedValue([
      { id: 'profile-1', label: 'Server password', keyType: 'profile', kind: 'password' },
      { id: 'key-1', label: 'Server key', keyType: 'rsa', kind: 'keyFile' },
    ]);

    await useKeychainStore.getState().hydrate();

    expect(useKeychainStore.getState().keys).toEqual([
      { id: 'profile-1', label: 'Server password', keyType: 'ecdsa', kind: 'password' },
      { id: 'key-1', label: 'Server key', keyType: 'rsa', kind: 'keyFile' },
    ]);
  });
});

describe('keychainStore addKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useKeychainStore.setState({ keys: [], initialized: true });
  });

  it('passes detected keyType to the backend when adding a key', async () => {
    invokeStoreKeyCredential.mockResolvedValue(undefined);

    await useKeychainStore.getState().addKey({
      label: 'Server key',
      kind: 'keyFile',
      privateKey: RSA_KEY,
    });

    expect(invokeStoreKeyCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        label: 'Server key',
        kind: 'keyFile',
        privateKey: RSA_KEY,
        keyType: 'rsa',
      }),
    );
  });
});
