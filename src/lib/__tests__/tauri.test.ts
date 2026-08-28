import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
const loggerErrorMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: loggerErrorMock,
    warn: vi.fn(),
  }),
}));

import {
  buildRemoteConnectionRequest,
  buildSessionCreateRequest,
  invokeAgentGetSnapshot,
  invokeAgentPause,
  invokeAgentSendMessage,
  invokeAgentStart,
  invokeCancelRemoteFileRead,
  invokeStoreKeyCredential,
  invokeListKeyCredentials,
  invokeListRemoteDirectory,
  invokeOpenRemoteFile,
  invokePreflightConnection,
  invokePreviewRemoteFile,
  invokeTrustHost,
} from '@/lib/tauri';
import { makeAgentActionResult, makeAgentSnapshot } from '@/test/agent-fixtures';
import type { ConnectionProfile } from '@/types';

beforeEach(() => {
  invokeMock.mockReset();
  loggerErrorMock.mockReset();
});

describe('Agent v1 narrow IPC contract', () => {
  it('uses only the six typed Agent command envelopes and strictly decodes results', async () => {
    const startRequest = {
      schemaVersion: 1 as const,
      clientRequestId: 'request-1',
      goal: 'Inspect disk pressure.',
      profileId: 'profile-1',
      providerId: 'provider-1',
    };
    const actionRequest = {
      schemaVersion: 1 as const,
      runId: 'run-1',
      clientActionId: 'action-1',
    };
    const messageRequest = { ...actionRequest, message: 'Also inspect inode pressure.' };
    const startResult = { schemaVersion: 1, runId: 'run-1', acceptedAt: 1_000 };
    invokeMock
      .mockResolvedValueOnce(startResult)
      .mockResolvedValueOnce(makeAgentSnapshot())
      .mockResolvedValueOnce(makeAgentActionResult('pause'))
      .mockResolvedValueOnce(makeAgentActionResult('sendMessage'));

    await expect(invokeAgentStart(startRequest)).resolves.toEqual(startResult);
    await expect(invokeAgentGetSnapshot({ schemaVersion: 1, runId: 'run-1' }))
      .resolves.toEqual(makeAgentSnapshot());
    await expect(invokeAgentPause(actionRequest)).resolves.toMatchObject({ action: 'pause' });
    await expect(invokeAgentSendMessage(messageRequest))
      .resolves.toMatchObject({ action: 'sendMessage' });

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'agent_start',
      'agent_get_snapshot',
      'agent_pause',
      'agent_send_message',
    ]);
    expect(invokeMock).toHaveBeenNthCalledWith(1, 'agent_start', { request: startRequest });
    expect(invokeMock).toHaveBeenNthCalledWith(4, 'agent_send_message', {
      request: messageRequest,
    });
  });

  it('rejects expanded backend result envelopes', async () => {
    invokeMock.mockResolvedValueOnce({
      schemaVersion: 1,
      runId: 'run-1',
      acceptedAt: 1_000,
      rawOutput: 'must not cross IPC',
    });

    await expect(invokeAgentStart({
      schemaVersion: 1,
      clientRequestId: 'request-1',
      goal: 'Inspect only.',
      profileId: 'profile-1',
      providerId: 'provider-1',
    })).rejects.toThrow(/unknown field/);
  });
});

describe('remote directory supersession', () => {
  const request = {
    host: 'server.example.com',
    port: 22,
    username: 'root',
    authMethod: 'password' as const,
    requestKey: 'epoch:pane:remote',
    requestId: 2,
  };

  it('does not log an expected stale directory request as an IPC failure', async () => {
    const superseded = {
      type: 'Other',
      payload: { message: 'remote directory request superseded' },
    };
    invokeMock.mockRejectedValueOnce(superseded);

    await expect(invokeListRemoteDirectory(request)).rejects.toBe(superseded);

    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('continues to log real directory failures', async () => {
    const failure = {
      type: 'Other',
      payload: { message: 'permission denied' },
    };
    invokeMock.mockRejectedValueOnce(failure);

    await expect(invokeListRemoteDirectory(request)).rejects.toBe(failure);

    expect(loggerErrorMock).toHaveBeenCalledOnce();
  });
});

describe('remote file read cancellation', () => {
  const request = {
    host: 'server.example.com',
    port: 22,
    username: 'root',
    authMethod: 'password' as const,
    path: '/var/log/large.log',
    operationId: 'remote-preview-test',
  };

  it('does not log an expected open or preview cancellation as an IPC failure', async () => {
    const cancelled = {
      type: 'Other',
      payload: { message: 'remote file read cancelled' },
    };
    invokeMock.mockRejectedValue(cancelled);

    await expect(invokeOpenRemoteFile(request)).rejects.toBe(cancelled);
    await expect(invokePreviewRemoteFile(request)).rejects.toBe(cancelled);

    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('keeps real remote file read failures visible and sends idempotent cancellation', async () => {
    const failure = {
      type: 'Other',
      payload: { message: 'permission denied' },
    };
    invokeMock.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);

    await expect(invokePreviewRemoteFile(request)).rejects.toBe(failure);
    await invokeCancelRemoteFileRead(request.operationId);

    expect(loggerErrorMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenLastCalledWith('cancel_remote_file_read', {
      operationId: request.operationId,
    });
  });
});

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

describe('host key trust serialization', () => {
  it('binds trust to the fingerprint shown by the confirmation prompt', async () => {
    invokeMock.mockResolvedValue(undefined);

    await invokeTrustHost(
      'server.example.com',
      2222,
      'ED25519 SHA256:confirmed',
    );

    expect(invokeMock).toHaveBeenCalledWith('trust_host', {
      request: {
        host: 'server.example.com',
        port: 2222,
        expectedFingerprint: 'ED25519 SHA256:confirmed',
      },
    });
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
