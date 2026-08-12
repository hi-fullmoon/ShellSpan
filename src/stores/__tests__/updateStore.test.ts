import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUpdateStore } from '../updateStore';

const mocks = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('@/stores/toastStore', () => ({
  useToastStore: {
    getState: () => ({ addToast: mocks.addToast }),
  },
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

vi.mock('@/locales', () => ({
  t: (key: string) => key,
}));

describe('updateStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUpdateStore.getState().reset();
  });

  it('reports that a download is active when another manual check is requested', async () => {
    let finishDownload!: () => void;
    const downloadPending = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });
    mocks.checkForUpdate.mockResolvedValue({ version: '2.1.0' });
    mocks.downloadAndInstallUpdate.mockReturnValue(downloadPending);

    void useUpdateStore.getState().runCheck('manual');

    await vi.waitFor(() => {
      expect(useUpdateStore.getState().phase).toBe('downloading');
    });

    await useUpdateStore.getState().runCheck('manual');

    expect(mocks.addToast).toHaveBeenCalledWith('update.downloading', 'info');

    finishDownload();
    await vi.waitFor(() => {
      expect(useUpdateStore.getState().phase).toBe('downloaded');
    });
  });

  it('immediately reports a found update while its download is pending', async () => {
    const downloadPending = new Promise<void>(() => {});
    mocks.checkForUpdate.mockResolvedValue({ version: '2.1.0' });
    mocks.downloadAndInstallUpdate.mockReturnValue(downloadPending);

    void useUpdateStore.getState().runCheck('manual');

    await vi.waitFor(() => {
      expect(useUpdateStore.getState().phase).toBe('downloading');
    });

    expect(mocks.addToast).toHaveBeenNthCalledWith(1, 'update.available', 'info');
  });

  it('reports a determinate download progress and reaches the downloaded state', async () => {
    let finishDownload!: () => void;
    const downloadPending = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });

    mocks.checkForUpdate.mockResolvedValue({ version: '2.1.0' });
    mocks.downloadAndInstallUpdate.mockImplementation((_update, onProgress) => {
      onProgress({ percent: 37, receivedBytes: 37, totalBytes: 100 });
      return downloadPending;
    });

    void useUpdateStore.getState().runCheck('manual');

    await vi.waitFor(() => {
      expect(useUpdateStore.getState().downloadProgress).toBe(37);
    });
    expect(useUpdateStore.getState().downloadIndeterminate).toBe(false);

    finishDownload();
    await vi.waitFor(() => {
      expect(useUpdateStore.getState().phase).toBe('downloaded');
    });
    expect(useUpdateStore.getState().downloadProgress).toBe(100);
  });

  it('marks an indeterminate download when the total size is unknown', async () => {
    let finishDownload!: () => void;
    const downloadPending = new Promise<void>((resolve) => {
      finishDownload = resolve;
    });

    mocks.checkForUpdate.mockResolvedValue({ version: '2.1.0' });
    mocks.downloadAndInstallUpdate.mockImplementation((_update, onProgress) => {
      onProgress({ receivedBytes: 4096, totalBytes: 0 });
      return downloadPending;
    });

    void useUpdateStore.getState().runCheck('manual');

    await vi.waitFor(() => {
      expect(useUpdateStore.getState().downloadIndeterminate).toBe(true);
    });

    finishDownload();
  });
});
