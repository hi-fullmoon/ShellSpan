import { describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  invokeStoreKeyCredential,
  invokeListKeyCredentials,
} from '@/lib/tauri';

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

  it('sends password kind unchanged', async () => {
    invokeMock.mockResolvedValue(undefined);

    await invokeStoreKeyCredential({
      id: 'profile-1',
      label: 'My Password',
      kind: 'password',
      privateKey: 'secret',
    });

    expect(invokeMock).toHaveBeenCalledWith('store_key_credential', {
      request: expect.objectContaining({ kind: 'password' }),
    });
  });

  it('maps lowercase keyfile from the backend to keyFile', async () => {
    invokeMock.mockResolvedValue([
      { id: 'key-1', label: 'My Key', keyType: 'rsa', kind: 'keyfile' },
    ]);

    const result = await invokeListKeyCredentials();

    expect(result[0].kind).toBe('keyFile');
  });
});
