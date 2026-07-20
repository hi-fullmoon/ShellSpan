import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useTransferStore } from '@/stores/transferStore';
import type {
  DeleteProgressEvent,
  DownloadProgressEvent,
  RemoteCopyProgressEvent,
  UploadProgressEvent,
} from '@/types';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';
import { t } from '@/locales';

export function useTransferListeners(): void {
  const updateUpload = useTransferStore((state) => state.updateUpload);
  const updateDownload = useTransferStore((state) => state.updateDownload);
  const updateDelete = useTransferStore((state) => state.updateDelete);
  const updateRemoteCopy = useTransferStore((state) => state.updateRemoteCopy);
  const addToast = useToastStore((state) => state.addToast);
  const notifiedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let unlistenUpload: (() => void) | undefined;
    let unlistenDownload: (() => void) | undefined;
    let unlistenDelete: (() => void) | undefined;
    let unlistenRemoteCopy: (() => void) | undefined;

    const setup = async (): Promise<void> => {
      const notifyCompleted = (operationId: string, totalSteps: number, completedSteps: number): void => {
        if (
          totalSteps <= 0 ||
          completedSteps < totalSteps ||
          notifiedRef.current.has(operationId)
        ) return;
        notifiedRef.current.add(operationId);
        if (
          useAppStore.getState().sftpCompletionNotification &&
          (document.visibilityState !== 'visible' || !document.hasFocus())
        ) {
          addToast(t('sftp.transfer.completedNotification'), 'success');
        }
      };
      unlistenUpload = await listen<UploadProgressEvent>(
        'upload-progress',
        (event) => {
          updateUpload(event.payload);
          notifyCompleted(event.payload.operationId, event.payload.totalSteps, event.payload.completedSteps);
        },
      );
      unlistenDownload = await listen<DownloadProgressEvent>(
        'download-progress',
        (event) => {
          updateDownload(event.payload);
          notifyCompleted(event.payload.operationId, event.payload.totalSteps, event.payload.completedSteps);
        },
      );
      unlistenDelete = await listen<DeleteProgressEvent>(
        'delete-progress',
        (event) => {
          updateDelete(event.payload);
        },
      );
      unlistenRemoteCopy = await listen<RemoteCopyProgressEvent>(
        'remote-copy-progress',
        (event) => {
          updateRemoteCopy(event.payload);
          notifyCompleted(event.payload.operationId, event.payload.totalSteps, event.payload.completedSteps);
        },
      );
    };

    setup();

    return () => {
      unlistenUpload?.();
      unlistenDownload?.();
      unlistenDelete?.();
      unlistenRemoteCopy?.();
    };
  }, [addToast, updateUpload, updateDownload, updateDelete, updateRemoteCopy]);
}
