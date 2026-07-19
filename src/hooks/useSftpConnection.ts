import { useCallback } from 'react';
import {
  invokeCopyRemotePath,
  invokeCancelDownload,
  invokeCreateRemoteEntry,
  invokeDeleteRemotePath,
  invokeDownloadRemotePaths,
  invokeListRemoteDirectory,
  invokeOpenRemoteFile,
  invokePreviewRemoteFile,
  invokeRenameRemotePath,
  invokeRestoreRemotePath,
  invokeTrashRemotePath,
  invokeUpdateRemotePermissions,
  invokeUploadLocalPaths,
} from '@/lib/tauri';
import {
  getSftpPaneConnection,
  getSftpPaneConnectionKey,
  useSftpStore,
  type SftpConnection,
} from '@/stores/sftpStore';
import { useTransferStore } from '@/stores/transferStore';
import { createLogger } from '@/lib/logger';
import type { SftpSide } from '@/stores/sftpStore';
import type {
  ReadRemoteFileResponse,
  TrashedRemotePath,
  UploadConflictPolicy,
} from '@/types';

const logger = createLogger('sftp');

const DELETE_UNDO_WINDOW_MS = 30_000;

function createOperationId(connectionId: string, kind: string): string {
  return `${connectionId}-${kind}-${crypto.randomUUID()}`;
}

export function useSftpConnection(connection: SftpConnection, side: SftpSide = 'remote'): {
  loadRemoteDirectory: (path?: string) => Promise<void>;
  createRemoteEntry: (parentPath: string, name: string, kind: 'file' | 'directory') => Promise<void>;
  renameRemotePath: (path: string, newName: string) => Promise<void>;
  copyRemotePath: (sourcePath: string, destinationDirectory: string) => Promise<void>;
  deleteRemotePaths: (paths: string[]) => Promise<void>;
  updateRemotePermissions: (path: string, permissions: number) => Promise<void>;
  uploadLocalPaths: (localPaths: string[], destinationDirectory: string, operationId?: string, conflictPolicies?: UploadConflictPolicy[]) => Promise<void>;
  downloadRemotePaths: (remotePaths: string[], destinationDirectory: string, operationId?: string) => Promise<void>;
  openRemoteFile: (path: string) => Promise<void>;
  previewRemoteFile: (path: string) => Promise<ReadRemoteFileResponse>;
} {
  const remoteConnection = getSftpPaneConnection(connection, side);
  const remoteConnectionKey = getSftpPaneConnectionKey(connection, side);
  const panePath = side === 'local' ? connection.localPath : connection.remotePath;
  const setPath = useSftpStore((state) => state.setPath);
  const setEntries = useSftpStore((state) => state.setEntries);
  const setLoading = useSftpStore((state) => state.setLoading);
  const setError = useSftpStore((state) => state.setError);
  const addOperation = useTransferStore((state) => state.addOperation);
  const markOperationRunning = useTransferStore(
    (state) => state.markOperationRunning,
  );
  const markOperationFailed = useTransferStore(
    (state) => state.markOperationFailed,
  );
  const updateDelete = useTransferStore((state) => state.updateDelete);
  const setOperationUndo = useTransferStore((state) => state.setOperationUndo);

  const loadRemoteDirectory = useCallback(
    async (path?: string) => {
      setLoading(connection.id, side, true);
      setError(connection.id, side);
      try {
        const listing = await invokeListRemoteDirectory({
          ...remoteConnection,
          path,
        });
        setPath(connection.id, side, listing.path);
        setEntries(connection.id, side, listing.entries);
      } catch (error) {
        setError(
          connection.id,
          side,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setLoading(connection.id, side, false);
      }
    },
    [connection.id, remoteConnection, setPath, setEntries, setLoading, setError, side],
  );

  const createRemoteEntry = useCallback(
    async (parentPath: string, name: string, kind: 'file' | 'directory') => {
      await invokeCreateRemoteEntry({
        ...remoteConnection,
        parentPath,
        name,
        kind,
      });
      await loadRemoteDirectory(panePath);
    },
    [remoteConnection, panePath, loadRemoteDirectory],
  );

  const renameRemotePath = useCallback(
    async (path: string, newName: string) => {
      await invokeRenameRemotePath({
        ...remoteConnection,
        path,
        newName,
      });
      await loadRemoteDirectory(panePath);
    },
    [remoteConnection, panePath, loadRemoteDirectory],
  );

  const copyRemotePath = useCallback(
    async (sourcePath: string, destinationDirectory: string) => {
      await invokeCopyRemotePath({
        ...remoteConnection,
        sourcePath,
        destinationDirectory,
      });
      await loadRemoteDirectory(panePath);
    },
    [remoteConnection, panePath, loadRemoteDirectory],
  );

  const deleteRemotePaths = useCallback(
    async (paths: string[]) => {
      const operationId = createOperationId(connection.id, 'delete');
      addOperation({
        operationId,
        kind: 'delete',
        connectionId: remoteConnectionKey,
        paths,
        currentPath: paths[0],
        totalBytes: 0,
        processedBytes: 0,
        totalSteps: paths.length,
        completedSteps: 0,
        status: 'running',
      });
      const trashedPaths: TrashedRemotePath[] = [];

      try {
        for (const [index, path] of paths.entries()) {
          const trashedPath = await invokeTrashRemotePath({
            ...remoteConnection,
            path,
          });
          trashedPaths.push(trashedPath);
          updateDelete({
            operationId,
            currentPath: path,
            totalSteps: paths.length,
            completedSteps: index + 1,
          });
        }

        const pendingRestorePaths = [...trashedPaths].reverse();
        setOperationUndo(operationId, async () => {
          while (pendingRestorePaths.length > 0) {
            const trashedPath = pendingRestorePaths[0];
            await invokeRestoreRemotePath({
              ...remoteConnection,
              ...trashedPath,
            });
            pendingRestorePaths.shift();
          }
          await loadRemoteDirectory(panePath);
        });
        setTimeout(() => {
          const operation = useTransferStore
            .getState()
            .operations.find((item) => item.operationId === operationId);

          if (operation?.status === 'restored' || operation?.status === 'restoring') {
            return;
          }
          if (operation?.status === 'failed' && operation.undo) {
            return;
          }

          useTransferStore.getState().removeOperation(operationId);
          void Promise.allSettled(
            trashedPaths.map((trashedPath, index) =>
              invokeDeleteRemotePath({
                ...remoteConnection,
                path: trashedPath.trashPath,
                operationId: `${operationId}-cleanup-${index}`,
              }),
            ),
          );
        }, DELETE_UNDO_WINDOW_MS);
        await loadRemoteDirectory(panePath);
      } catch (error) {
        for (const trashedPath of [...trashedPaths].reverse()) {
          try {
            await invokeRestoreRemotePath({
              ...remoteConnection,
              ...trashedPath,
            });
          } catch {
            // Keep the original failure visible; any item already in trash remains recoverable.
          }
        }
        markOperationFailed(
          operationId,
          error instanceof Error ? error.message : String(error),
        );
        await loadRemoteDirectory(panePath);
        throw error;
      }
    },
    [
      addOperation,
      remoteConnection,
      remoteConnectionKey,
      connection.id,
      panePath,
      loadRemoteDirectory,
      markOperationFailed,
      setOperationUndo,
      updateDelete,
    ],
  );

  const updateRemotePermissions = useCallback(
    async (path: string, permissions: number) => {
      await invokeUpdateRemotePermissions({
        ...remoteConnection,
        path,
        permissions,
      });
      await loadRemoteDirectory(panePath);
    },
    [remoteConnection, panePath, loadRemoteDirectory],
  );

  const uploadLocalPaths = useCallback(
    async (localPaths: string[], destinationDirectory: string, operationId = `${connection.id}-upload-${Date.now()}`, conflictPolicies: UploadConflictPolicy[] = []) => {
      const runUpload = async (): Promise<void> => {
        markOperationRunning(operationId);
        try {
          await invokeUploadLocalPaths({
            ...remoteConnection,
            destinationDirectory,
            localPaths,
            conflictPolicies,
            operationId,
          });
        } catch (error) {
          markOperationFailed(
            operationId,
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        }
      };

      addOperation({
        operationId,
        kind: 'upload',
        connectionId: remoteConnectionKey,
        paths: [destinationDirectory],
        currentPath: localPaths[0],
        totalBytes: 0,
        processedBytes: 0,
        totalSteps: localPaths.length,
        completedSteps: 0,
        status: 'running',
        retry: runUpload,
      });
      await runUpload();
    },
    [
      remoteConnection,
      remoteConnectionKey,
      connection.id,
      panePath,
      addOperation,
      markOperationFailed,
      markOperationRunning,
    ],
  );

  const downloadRemotePaths = useCallback(
    async (remotePaths: string[], destinationDirectory: string, operationId = createOperationId(connection.id, 'download')) => {
      addOperation({
        operationId,
        kind: 'download',
        connectionId: remoteConnectionKey,
        paths: remotePaths,
        currentPath: remotePaths[0],
        totalBytes: 0,
        processedBytes: 0,
        totalSteps: remotePaths.length,
        completedSteps: 0,
        status: 'running',
        cancel: () => invokeCancelDownload(operationId),
      });
      try {
        await invokeDownloadRemotePaths({
          ...remoteConnection,
          remotePaths,
          destinationDirectory,
          operationId,
        });
      } catch (error) {
        const operation = useTransferStore.getState().operations.find(
          (item) => item.operationId === operationId,
        );
        if (operation?.status === 'cancelling') {
          useTransferStore.getState().markOperationCancelled(operationId);
          return;
        }
        markOperationFailed(
          operationId,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    },
    [remoteConnection, remoteConnectionKey, connection.id, addOperation, markOperationFailed],
  );

  const openRemoteFile = useCallback(
    async (path: string) => {
      await invokeOpenRemoteFile({
        ...remoteConnection,
        path,
      });
    },
    [remoteConnection],
  );

  const previewRemoteFile = useCallback(
    async (path: string): Promise<ReadRemoteFileResponse> => {
      return invokePreviewRemoteFile({
        ...remoteConnection,
        path,
      });
    },
    [remoteConnection],
  );

  return {
    loadRemoteDirectory,
    createRemoteEntry,
    renameRemotePath,
    copyRemotePath,
    deleteRemotePaths,
    updateRemotePermissions,
    uploadLocalPaths,
    downloadRemotePaths,
    openRemoteFile,
    previewRemoteFile,
  };
}
