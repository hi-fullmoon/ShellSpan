import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));

import {
  getPetdexStatus,
  listenToPetdexStatus,
  testPetdexConnection,
} from '@/lib/petdex/petdex';
import { isPetdexDiagnostic } from '@/lib/petdex/diagnostic';

const disabled = { revision: 0, status: 'disabled', errorReason: null, targetAction: null, lastSuccessAt: null } as const;

describe('Petdex IPC boundary', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
  });

  it('accepts only structured diagnostics with finite categories', () => {
    expect(isPetdexDiagnostic(disabled)).toBe(true);
    expect(isPetdexDiagnostic('notDetected')).toBe(false);
    expect(isPetdexDiagnostic({ ...disabled, status: 'waiting' })).toBe(false);
    expect(isPetdexDiagnostic({ message: 'free text' })).toBe(false);
  });

  it('normalizes unexpected command payloads without exposing details', async () => {
    mocks.invoke
      .mockResolvedValueOnce({ detail: 'unexpected backend payload' })
      .mockResolvedValueOnce({ diagnostic: disabled, preview: 'disabled' });

    await expect(getPetdexStatus()).rejects.toThrow('petdex-invalid-diagnostic');
    await expect(testPetdexConnection()).resolves.toEqual({ diagnostic: disabled, preview: 'disabled' });
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'petdex_get_status');
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'petdex_test_connection');
  });

  it('ignores invalid event payloads without replacing valid diagnostics', async () => {
    const unlisten = vi.fn();
    mocks.listen.mockImplementation(async (_event, callback) => {
      callback({ payload: 'unexpected free text' });
      return unlisten;
    });
    const callback = vi.fn();

    await listenToPetdexStatus(callback);

    expect(mocks.listen).toHaveBeenCalledWith('petdex-status', expect.any(Function));
    expect(callback).not.toHaveBeenCalled();
  });
});
