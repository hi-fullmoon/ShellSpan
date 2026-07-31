import { useEffect, useRef } from 'react';
import { listen, type Event } from '@tauri-apps/api/event';
import { useTransferStore } from '@/stores/transferStore';
import type {
  DeleteProgressEvent,
  DownloadProgressEvent,
  RemoteCopyProgressEvent,
  UploadProgressEvent,
} from '@/types';
import { useAppStore } from '@/stores/appStore';
import { useToastStore } from '@/stores/toastStore';
import { createLogger } from '@/lib/logger';
import { t } from '@/locales';

const logger = createLogger('transfer');

export function useTransferListeners(): void {
  const updateUpload = useTransferStore((state) => state.updateUpload);
  const updateDownload = useTransferStore((state) => state.updateDownload);
  const updateDelete = useTransferStore((state) => state.updateDelete);
  const updateRemoteCopy = useTransferStore((state) => state.updateRemoteCopy);
  const addToast = useToastStore((state) => state.addToast);
  const notifiedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    const register = async <T>(
      eventName: string,
      handler: (event: Event<T>) => void,
    ): Promise<void> => {
      const unlisten = await listen<T>(eventName, handler);
      // The effect may have been cleaned up while the listener was
      // registering; release it immediately instead of leaking it.
      if (disposed) {
        unlisten();
        return;
      }
      unlisteners.push(unlisten);
    };

    // Drop ids whose operation has ended or been removed so the set does not
    // grow without bound; entries for completed operations are kept while the
    // operation lives to suppress duplicate completion events.
    const pruneNotified = (): void => {
      const operations = useTransferStore.getState().operations;
      notifiedRef.current.forEach((operationId) => {
        const operation = operations.find(
          (item) => item.operationId === operationId,
        );
        if (
          !operation ||
          operation.status === 'failed' ||
          operation.status === 'cancelled'
        ) {
          notifiedRef.current.delete(operationId);
        }
      });
    };

    const notifyCompleted = (operationId: string, totalSteps: number, completedSteps: number): void => {
      pruneNotified();
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

    const setup = async (): Promise<void> => {
      await Promise.all([
        register<UploadProgressEvent>(
          'upload-progress',
          (event) => {
            updateUpload(event.payload);
            notifyCompleted(event.payload.operationId, event.payload.totalSteps, event.payload.completedSteps);
          },
        ),
        register<DownloadProgressEvent>(
          'download-progress',
          (event) => {
            updateDownload(event.payload);
            notifyCompleted(event.payload.operationId, event.payload.totalSteps, event.payload.completedSteps);
          },
        ),
        register<DeleteProgressEvent>(
          'delete-progress',
          (event) => {
            updateDelete(event.payload);
          },
        ),
        register<RemoteCopyProgressEvent>(
          'remote-copy-progress',
          (event) => {
            updateRemoteCopy(event.payload);
            notifyCompleted(event.payload.operationId, event.payload.totalSteps, event.payload.completedSteps);
          },
        ),
      ]);
    };

    setup().catch((error) => {
      logger.error('Failed to register transfer progress listeners', error);
    });

    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
      unlisteners.length = 0;
    };
  }, [addToast, updateUpload, updateDownload, updateDelete, updateRemoteCopy]);
}
