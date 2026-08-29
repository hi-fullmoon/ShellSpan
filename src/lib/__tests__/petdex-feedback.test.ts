import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
}));

vi.mock('@/lib/tauri', () => ({
  isTauriRuntime: tauriMocks.isTauriRuntime,
}));

import {
  openPetdexPhase3Feedback,
  PETDEX_PHASE3_FEEDBACK_URL,
} from '@/lib/petdex-feedback';

describe('Petdex Phase 3 feedback link', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset().mockResolvedValue(undefined);
    tauriMocks.isTauriRuntime.mockReset().mockReturnValue(true);
  });

  it('opens only the fixed voluntary GitHub form in Tauri', async () => {
    await openPetdexPhase3Feedback();

    expect(tauriMocks.invoke).toHaveBeenCalledWith('open_url', {
      url: 'https://github.com/hi-fullmoon/TermBridge/issues/new?template=petdex-phase3-feedback.yml',
    });
    expect(PETDEX_PHASE3_FEEDBACK_URL).not.toContain('token');
  });

  it('uses a noopener browser tab without adding app data', async () => {
    tauriMocks.isTauriRuntime.mockReturnValue(false);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    await openPetdexPhase3Feedback();

    expect(open).toHaveBeenCalledWith(
      PETDEX_PHASE3_FEEDBACK_URL,
      '_blank',
      'noopener,noreferrer',
    );
    open.mockRestore();
  });
});
