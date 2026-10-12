import { describe, expect, it } from 'vitest';
import { credentialEndpoint, credentialLabel, credentialProfiles, credentialSearchText } from '../keychain-panel';
import type { ConnectionProfile } from '@/types';
import type { KeychainKeySummary } from '@/stores/keychainStore';

const profiles: ConnectionProfile[] = ['root', 'admin'].map((username) => ({
  id: username, name: '175.178.66.45', host: '175.178.66.45', port: 22,
  username, authMethod: 'password', createdAt: 0, updatedAt: 0,
}));
const password: KeychainKeySummary = {
  id: 'root', label: '175.178.66.45', keyType: 'profile', kind: 'password',
  service: 'com.shellspan.profile-password',
};

describe('credential identity display', () => {
  it('distinguishes passwords for different accounts on the same host', () => {
    expect(credentialLabel(password, profiles)).toBe('root@175.178.66.45');
    expect(credentialLabel({ ...password, id: 'admin' }, profiles)).toBe('admin@175.178.66.45');
    expect(credentialProfiles(password, profiles)).toEqual([profiles[0]]);
    expect(credentialEndpoint(profiles[1])).toBe('admin@175.178.66.45:22');
  });

  it('preserves custom key labels and labels for unlinked credentials', () => {
    expect(credentialLabel({ ...password, service: 'com.shellspan.key', label: 'Shared key' }, profiles)).toBe('Shared key');
    expect(credentialLabel(password, [])).toBe(password.label);
  });

  it('searches the original connection name and complete endpoint', () => {
    const connection = { ...profiles[0], name: 'Production', port: 2222 };
    const text = credentialSearchText(password, [connection]);
    for (const query of ['production', 'root', '175.178.66.45', '2222', 'root@175.178.66.45:2222']) {
      expect(text).toContain(query);
    }
    expect(text).not.toContain('admin');
  });

  it('formats IPv6 endpoints without ambiguity', () => {
    expect(credentialEndpoint({ ...profiles[0], host: '2001:db8::1' })).toBe('root@[2001:db8::1]:22');
  });

  it('finds all connections sharing a key, including jump host references', () => {
    const key = { ...password, id: 'shared', service: 'com.shellspan.key' };
    const connections = [
      { ...profiles[0], keychainKeyId: 'shared' },
      { ...profiles[1], jumpHost: { host: 'jump', username: 'jump', port: 22, authMethod: 'key' as const, keychainKeyId: 'shared' } },
    ];
    expect(credentialProfiles(key, connections)).toEqual(connections);
  });
});
