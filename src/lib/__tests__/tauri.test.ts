import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  buildRemoteConnectionRequest,
  buildSessionCreateRequest,
  invokeStoreKeyCredential,
  invokeListKeyCredentials,
  invokePreflightConnection,
} from '@/lib/tauri';
import type { ConnectionProfile } from '@/types';

describe('keychain kind serialization', () => {
  it('sends keyFile as lowercase keyfile to the backend', async () => {
    invokeMock.mockResolvedValue(undefined);

    await invokeStoreKeyCredential({
      id: 'key-1',
      label: 'My Key',
      kind: 'keyFile',
      privateKey: 'private-key-data',
    });

    expect(invokeMock).toHaveBeenCalledWith('store_key_credential', {
      request: {
        id: 'key-1',
        label: 'My Key',
        kind: 'keyfile',
        privateKey: 'private-key-data',
      },
    });
  });

  it('maps lowercase keyfile from the backend to keyFile', async () => {
    invokeMock.mockResolvedValue([
      { id: 'key-1', label: 'My Key', keyType: 'rsa', kind: 'keyfile', service: 'com.termbridge.key' },
    ]);

    const result = await invokeListKeyCredentials();

    expect(result[0].kind).toBe('keyFile');
  });
});

describe('connection request serialization', () => {
  const passwordProfile: ConnectionProfile = {
    id: 'p1',
    name: 'Server',
    host: 'h',
    port: 22,
    username: 'u',
    authMethod: 'password',
    password: 'secret',
    keychainKeyId: 'password-key',
    jumpHost: {
      host: 'jump',
      port: 22,
      username: 'ju',
      authMethod: 'password',
      password: 'jump-secret',
      keychainKeyId: 'jump-password-key',
    },
    createdAt: 0,
    updatedAt: 0,
  };

  it('omits keychain ids for password-authenticated session requests', () => {
    const request = buildSessionCreateRequest(passwordProfile, 120, 30);

    expect(request.keychainKeyId).toBeUndefined();
    expect(request.jumpHost?.keychainKeyId).toBeUndefined();
    expect(request.password).toBe('secret');
  });

  it('omits keychain ids for password-authenticated remote requests', () => {
    const request = buildRemoteConnectionRequest(passwordProfile);

    expect(request.keychainKeyId).toBeUndefined();
    expect(request.jumpHost?.keychainKeyId).toBeUndefined();
    expect(request.password).toBe('secret');
  });

  it('keeps keychain ids for key-authenticated requests', () => {
    const keyProfile: ConnectionProfile = {
      ...passwordProfile,
      authMethod: 'key',
      password: undefined,
      keychainKeyId: 'key-1',
      jumpHost: {
        ...passwordProfile.jumpHost!,
        authMethod: 'key',
        password: undefined,
        keychainKeyId: 'jump-key-1',
      },
    };

    const request = buildSessionCreateRequest(keyProfile, 120, 30);

    expect(request.keychainKeyId).toBe('key-1');
    expect(request.jumpHost?.keychainKeyId).toBe('jump-key-1');
  });

  it('wraps connection preflight fields for the native command', async () => {
    invokeMock.mockResolvedValue({
      operationId: 'connection-preflight-test',
      status: 'passed',
      checkedAt: 1,
      steps: [],
    });

    await invokePreflightConnection({
      operationId: 'connection-preflight-test',
      host: 'server.example.com',
      port: 22,
      username: 'root',
      authMethod: 'password',
      password: 'secret',
    });

    expect(invokeMock).toHaveBeenCalledWith('preflight_connection', {
      request: {
        operationId: 'connection-preflight-test',
        host: 'server.example.com',
        port: 22,
        username: 'root',
        authMethod: 'password',
        password: 'secret',
      },
    });
  });
});
