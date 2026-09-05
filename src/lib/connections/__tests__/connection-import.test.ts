import { describe, expect, it, vi } from 'vitest';
import {
  buildConnectionImportPreview,
  exportConnections,
  importConnectionsTransactionally,
  parseConnectionExport,
  parseOpenSshConfig,
} from '@/lib/connections/connection-import';

describe('OpenSSH connection import', () => {
  it('parses aliases, identity files, ports and a ProxyJump', () => {
    const candidates = parseOpenSshConfig(`
      Host api
        HostName api.example.test
        User deploy
        Port 2222
        IdentityFile "C:/Keys/deploy key"
        ProxyJump bastion@jump.example.test:2200
      Host wildcard-*
        User ignored
    `);

    expect(candidates).toEqual([expect.objectContaining({
      name: 'api',
      host: 'api.example.test',
      port: 2222,
      username: 'deploy',
      authMethod: 'key',
      identityFile: 'C:/Keys/deploy key',
      jumpHost: expect.objectContaining({
        host: 'jump.example.test',
        port: 2200,
        username: 'bastion',
      }),
    })]);
  });

  it('flags multi-hop ProxyJump instead of silently changing its meaning', () => {
    expect(parseOpenSshConfig('Host api\n User deploy\n ProxyJump a@one,b@two')[0])
      .toMatchObject({ warnings: ['unsupported-proxy-jump'] });
  });
});

describe('transactional connection import', () => {
  const candidate = (id: string, identityFile = '~/.ssh/id_ed25519') => ({
    id,
    source: 'openssh' as const,
    name: id,
    host: `${id}.example.test`,
    port: 22,
    username: 'deploy',
    authMethod: 'key' as const,
    identityFile,
    warnings: [],
  });

  it('reuses one imported key when aliases share an IdentityFile', async () => {
    const readTextFile = vi.fn(async () => 'PRIVATE KEY');
    const addKey = vi.fn(async () => ({ id: 'key-1' }));
    const addProfile = vi.fn(async (profile) => ({ id: `profile-${profile.name}` }));

    const result = await importConnectionsTransactionally(
      [candidate('api'), candidate('worker')],
      {
        readTextFile,
        addKey,
        removeKey: vi.fn(),
        addProfile,
        removeProfile: vi.fn(),
      },
    );

    expect(result).toEqual({
      profileIds: ['profile-api', 'profile-worker'],
      keyIds: ['key-1'],
    });
    expect(readTextFile).toHaveBeenCalledTimes(1);
    expect(addKey).toHaveBeenCalledTimes(1);
    expect(addProfile).toHaveBeenNthCalledWith(2, expect.objectContaining({ keychainKeyId: 'key-1' }));
  });

  it('rolls back profiles and keys created before a batch failure', async () => {
    const removeProfile = vi.fn(async () => undefined);
    const removeKey = vi.fn(async () => []);
    const addProfile = vi.fn()
      .mockResolvedValueOnce({ id: 'profile-api' })
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(importConnectionsTransactionally(
      [candidate('api'), candidate('worker')],
      {
        readTextFile: vi.fn(async () => 'PRIVATE KEY'),
        addKey: vi.fn(async () => ({ id: 'key-1' })),
        removeKey,
        addProfile,
        removeProfile,
      },
    )).rejects.toThrow('database unavailable');

    expect(removeProfile).toHaveBeenCalledWith('profile-api');
    expect(removeKey).toHaveBeenCalledWith('key-1');
  });
});

describe('ShellSpan connection export', () => {
  const profile = {
    id: 'profile-1',
    name: 'API',
    host: 'api.example.test',
    port: 22,
    username: 'deploy',
    authMethod: 'password' as const,
    password: 'must-not-export',
    keychainKeyId: 'device-only-key-id',
    createdAt: 1,
    updatedAt: 1,
  };

  it('never exports secrets, ids, or device-local key references', () => {
    const exported = exportConnections([{
      ...profile,
      group: 'Production',
      tags: ['api'],
      favorite: true,
      notes: 'api_key=must-redact operational note',
      portForwards: [{
        id: 'forward-database',
        name: 'Database',
        kind: 'local',
        localPort: 15432,
        remoteHost: '127.0.0.1',
        remotePort: 5432,
        autoStart: true,
      }],
      quickActions: [
        {
          id: 'command-status',
          kind: 'command',
          label: 'Status',
          command: 'systemctl status api',
        },
        {
          id: 'command-secret',
          kind: 'command',
          label: 'Unsafe',
          command: 'password=must-not-export',
        },
      ],
    }], '2026-08-23T00:00:00.000Z');
    expect(exported).not.toContain('must-not-export');
    expect(exported).not.toContain('device-only-key-id');
    expect(exported).not.toContain('profile-1');
    expect(exported).not.toContain('must-redact');
    expect(exported).not.toContain('must-not-export');
    expect(parseConnectionExport(exported)[0]).toMatchObject({
      group: 'Production',
      tags: ['api'],
      favorite: true,
      notes: 'api_key=[REDACTED] operational note',
      portForwards: [expect.objectContaining({
        id: 'forward-database',
        autoStart: true,
      })],
      quickActions: [expect.objectContaining({
        id: 'command-status',
        command: 'systemctl status api',
      })],
    });
  });

  it('marks name or endpoint collisions for explicit selection', () => {
    const preview = buildConnectionImportPreview(parseConnectionExport(exportConnections([profile])), [profile]);
    expect(preview[0]?.conflict).toBe(true);
  });

  it('drops a jump host object if it contains a secret-bearing field', () => {
    const imported = parseConnectionExport(JSON.stringify({
      schemaVersion: 1,
      profiles: [{
        name: 'API', host: 'api.test', port: 22, username: 'deploy', authMethod: 'password',
        jumpHost: {
          host: 'jump.test', port: 22, username: 'jump', authMethod: 'password', password: 'secret',
        },
      }],
    }));

    expect(imported[0]?.jumpHost).toBeUndefined();
  });

  it('drops a forwarding rule if it contains an unexpected secret-bearing field', () => {
    const imported = parseConnectionExport(JSON.stringify({
      schemaVersion: 2,
      profiles: [{
        name: 'API',
        host: 'api.test',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
        portForwards: [{
          id: 'forward-1',
          name: 'Database',
          kind: 'local',
          localPort: 15432,
          remoteHost: '127.0.0.1',
          remotePort: 5432,
          autoStart: true,
          password: 'must-not-import',
        }],
      }],
    }));

    expect(imported[0]?.portForwards).toEqual([]);
  });

  it('drops a quick action if it contains an unexpected secret-bearing field', () => {
    const imported = parseConnectionExport(JSON.stringify({
      schemaVersion: 3,
      profiles: [{
        name: 'API',
        host: 'api.test',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
        quickActions: [{
          id: 'command-1',
          kind: 'command',
          label: 'Status',
          command: 'systemctl status api',
          password: 'unexpected-secret',
        }],
      }],
    }));

    expect(imported[0]?.quickActions).toEqual([]);
  });
});
