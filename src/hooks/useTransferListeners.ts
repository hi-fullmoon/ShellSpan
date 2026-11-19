import { useEffect } from 'react';
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

    const unsubscribe = useTransferStore.subscribe((state, previous) => {
      if (state.pathOccupancyRevision === previous.pathOccupancyRevision
        || !useAppStore.getState().sftpCompletionNotification
        || (document.visibilityState === 'visible' && document.hasFocus())) return;
      const previouslyCompleted = new Set(previous.operations
        .filter((operation) => operation.status === 'completed')
        .map((operation) => operation.operationId));
      for (const operation of state.operations) {
        if (operation.status === 'completed' && operation.kind !== 'delete'
          && operation.totalSteps > 0 && !previouslyCompleted.has(operation.operationId)) {
          addToast(t('sftp.transfer.completedNotification'), 'success');
        }
      }
    });

    const setup = async (): Promise<void> => {
      await Promise.all([
        register<UploadProgressEvent>(
          'upload-progress',
          (event) => updateUpload(event.payload),
        ),
        register<DownloadProgressEvent>(
          'download-progress',
          (event) => updateDownload(event.payload),
        ),
        register<DeleteProgressEvent>(
          'delete-progress',
          (event) => {
            updateDelete(event.payload);
          },
        ),
        register<RemoteCopyProgressEvent>(
          'remote-copy-progress',
          (event) => updateRemoteCopy(event.payload),
        ),
      ]);
    };

    setup().catch((error) => {
      logger.error('Failed to register transfer progress listeners', error);
    });

    return () => {
      disposed = true;
      unsubscribe();
      unlisteners.forEach((unlisten) => unlisten());
      unlisteners.length = 0;
    };
  }, [addToast, updateUpload, updateDownload, updateDelete, updateRemoteCopy]);
}
