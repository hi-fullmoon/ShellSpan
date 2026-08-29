import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));

import {
  configurePetdex,
  getPetdexStatus,
  isPetdexConnectionStatus,
  listenToPetdexStatus,
  testPetdexConnection,
} from '@/lib/petdex';

describe('Petdex IPC boundary', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
  });

  it('accepts only the finite connection status enum', () => {
    expect(isPetdexConnectionStatus('notDetected')).toBe(true);
    expect(isPetdexConnectionStatus('connected')).toBe(true);
    expect(isPetdexConnectionStatus('notRunning')).toBe(true);
    expect(isPetdexConnectionStatus('connectionError')).toBe(true);
    expect(isPetdexConnectionStatus('waiting')).toBe(false);
    expect(isPetdexConnectionStatus({ message: 'free text' })).toBe(false);
  });

  it('sends only an enabled boolean when configuring the adapter', async () => {
    mocks.invoke.mockResolvedValue('notDetected');

    await expect(configurePetdex(true)).resolves.toBe('notDetected');

    expect(mocks.invoke).toHaveBeenCalledWith('petdex_set_enabled', { enabled: true });
  });

  it('normalizes unexpected command payloads without exposing details', async () => {
    mocks.invoke
      .mockResolvedValueOnce({ detail: 'unexpected backend payload' })
      .mockResolvedValueOnce('connected');

    await expect(getPetdexStatus()).resolves.toBe('connectionError');
    await expect(testPetdexConnection()).resolves.toBe('connected');
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'petdex_get_status');
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'petdex_test_connection');
  });

  it('normalizes unexpected event payloads to the finite error category', async () => {
    const unlisten = vi.fn();
    mocks.listen.mockImplementation(async (_event, callback) => {
      callback({ payload: 'unexpected free text' });
      return unlisten;
    });
    const callback = vi.fn();

    await listenToPetdexStatus(callback);

    expect(mocks.listen).toHaveBeenCalledWith('petdex-status', expect.any(Function));
    expect(callback).toHaveBeenCalledWith('connectionError');
  });
});
