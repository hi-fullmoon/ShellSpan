import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTransferStore } from '@/stores/transferStore';
import type {
  DeleteProgressEvent,
  DownloadProgressEvent,
  UploadProgressEvent,
} from '@/types';

export function useTransferListeners(): void {
  const updateUpload = useTransferStore((state) => state.updateUpload);
  const updateDownload = useTransferStore((state) => state.updateDownload);
  const updateDelete = useTransferStore((state) => state.updateDelete);

  useEffect(() => {
    let unlistenUpload: (() => void) | undefined;
    let unlistenDownload: (() => void) | undefined;
    let unlistenDelete: (() => void) | undefined;

    const setup = async (): Promise<void> => {
      unlistenUpload = await listen<UploadProgressEvent>(
        'upload-progress',
        (event) => {
          updateUpload(event.payload);
        },
      );
      unlistenDownload = await listen<DownloadProgressEvent>(
        'download-progress',
        (event) => {
          updateDownload(event.payload);
        },
      );
      unlistenDelete = await listen<DeleteProgressEvent>(
        'delete-progress',
        (event) => {
          updateDelete(event.payload);
        },
      );
    };

    setup();

    return () => {
      unlistenUpload?.();
      unlistenDownload?.();
      unlistenDelete?.();
    };
  }, [updateUpload, updateDownload, updateDelete]);
}
