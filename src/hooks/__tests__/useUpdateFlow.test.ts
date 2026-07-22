import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUpdateFlow } from '../useUpdateFlow';

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ info: mocks.info, error: mocks.error }),
}));

vi.mock('@/hooks/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/tauri', () => ({
  isTauriRuntime: () => true,
  invokeRequestAppRestart: vi.fn(),
}));

vi.mock('@/lib/update', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/update')>();
  return {
    ...actual,
    checkForUpdate: mocks.checkForUpdate,
    downloadAndInstallUpdate: mocks.downloadAndInstallUpdate,
    markStartupUpdateCheck: vi.fn(),
    shouldRunStartupUpdateCheck: vi.fn(() => false),
  };
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

describe('useUpdateFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports that a download is active when another manual check is requested', async () => {
    let finishDownload!: () => void;
    const downloadPending = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });
    mocks.checkForUpdate.mockResolvedValue({ version: '2.1.0' });
    mocks.downloadAndInstallUpdate.mockReturnValue(downloadPending);

    const { result } = renderHook(() =>
      useUpdateFlow({ startupUpdateCheck: false }),
    );

    act(() => {
      void result.current.runUpdateCheck('manual');
    });

    await waitFor(() => {
      expect(result.current.updateState.phase).toBe('downloading');
    });

    await act(async () => {
      await result.current.runUpdateCheck('manual');
    });

    expect(mocks.info).toHaveBeenCalledWith('update.downloading');

    finishDownload();
    await waitFor(() => {
      expect(result.current.updateState.phase).toBe('downloaded');
    });
  });

  it('immediately reports a found update while its download is pending', async () => {
    const downloadPending = new Promise<void>(() => {});
    mocks.checkForUpdate.mockResolvedValue({ version: '2.1.0' });
    mocks.downloadAndInstallUpdate.mockReturnValue(downloadPending);

    const { result } = renderHook(() =>
      useUpdateFlow({ startupUpdateCheck: false }),
    );

    act(() => {
      void result.current.runUpdateCheck('manual');
    });

    await waitFor(() => {
      expect(result.current.updateState.phase).toBe('downloading');
    });

    expect(mocks.info).toHaveBeenNthCalledWith(1, 'update.checking');
    expect(mocks.info).toHaveBeenNthCalledWith(2, 'update.available');
  });
});
