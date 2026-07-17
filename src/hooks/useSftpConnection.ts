import { useCallback } from 'react';
import {
  invokeCopyRemotePath,
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
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';
import { useTransferStore } from '@/stores/transferStore';
import type { SftpSide } from '@/stores/sftpStore';
import type {
  ReadRemoteFileResponse,
  TrashedRemotePath,
  UploadConflictPolicy,
} from '@/types';

const DELETE_UNDO_WINDOW_MS = 30_000;

export function useSftpConnection(connection: SftpConnection): {
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
      setLoading(connection.id, 'remote', true);
      setError(connection.id, 'remote');
      try {
        const listing = await invokeListRemoteDirectory({
          ...connection.connection,
          path,
        });
        setPath(connection.id, 'remote', listing.path);
        setEntries(connection.id, 'remote', listing.entries);
      } catch (error) {
        setError(
          connection.id,
          'remote',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setLoading(connection.id, 'remote', false);
      }
    },
    [connection.id, connection.connection, setPath, setEntries, setLoading, setError],
  );

  const createRemoteEntry = useCallback(
    async (parentPath: string, name: string, kind: 'file' | 'directory') => {
      await invokeCreateRemoteEntry({
        ...connection.connection,
        parentPath,
        name,
        kind,
      });
      await loadRemoteDirectory(connection.remotePath);
    },
    [connection.connection, connection.remotePath, loadRemoteDirectory],
  );

  const renameRemotePath = useCallback(
    async (path: string, newName: string) => {
      await invokeRenameRemotePath({
        ...connection.connection,
        path,
        newName,
      });
      await loadRemoteDirectory(connection.remotePath);
    },
    [connection.connection, connection.remotePath, loadRemoteDirectory],
  );

  const copyRemotePath = useCallback(
    async (sourcePath: string, destinationDirectory: string) => {
      await invokeCopyRemotePath({
        ...connection.connection,
        sourcePath,
        destinationDirectory,
      });
      await loadRemoteDirectory(connection.remotePath);
    },
    [connection.connection, connection.remotePath, loadRemoteDirectory],
  );

  const deleteRemotePaths = useCallback(
    async (paths: string[]) => {
      const operationId = `${connection.id}-delete-${Date.now()}`;
      addOperation({
        operationId,
        kind: 'delete',
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
            ...connection.connection,
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
              ...connection.connection,
              ...trashedPath,
            });
            pendingRestorePaths.shift();
          }
          await loadRemoteDirectory(connection.remotePath);
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
                ...connection.connection,
                path: trashedPath.trashPath,
                operationId: `${operationId}-cleanup-${index}`,
              }),
            ),
          );
        }, DELETE_UNDO_WINDOW_MS);
        await loadRemoteDirectory(connection.remotePath);
      } catch (error) {
        for (const trashedPath of [...trashedPaths].reverse()) {
          try {
            await invokeRestoreRemotePath({
              ...connection.connection,
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
        await loadRemoteDirectory(connection.remotePath);
        throw error;
      }
    },
    [
      addOperation,
      connection.connection,
      connection.id,
      connection.remotePath,
      loadRemoteDirectory,
      markOperationFailed,
      setOperationUndo,
      updateDelete,
    ],
  );

  const updateRemotePermissions = useCallback(
    async (path: string, permissions: number) => {
      await invokeUpdateRemotePermissions({
        ...connection.connection,
        path,
        permissions,
      });
      await loadRemoteDirectory(connection.remotePath);
    },
    [connection.connection, connection.remotePath, loadRemoteDirectory],
  );

  const uploadLocalPaths = useCallback(
    async (localPaths: string[], destinationDirectory: string, operationId = `${connection.id}-upload-${Date.now()}`, conflictPolicies: UploadConflictPolicy[] = []) => {
      const runUpload = async (): Promise<void> => {
        markOperationRunning(operationId);
        try {
          await invokeUploadLocalPaths({
            ...connection.connection,
            destinationDirectory,
            localPaths,
            conflictPolicies,
            operationId,
          });
          await loadRemoteDirectory(connection.remotePath);
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
      connection.connection,
      connection.id,
      connection.remotePath,
      loadRemoteDirectory,
      addOperation,
      markOperationFailed,
      markOperationRunning,
    ],
  );

  const downloadRemotePaths = useCallback(
    async (remotePaths: string[], destinationDirectory: string, operationId = `${connection.id}-download-${Date.now()}`) => {
      addOperation({
        operationId,
        kind: 'download',
        currentPath: remotePaths[0],
        totalBytes: 0,
        processedBytes: 0,
        totalSteps: remotePaths.length,
        completedSteps: 0,
      });
      await invokeDownloadRemotePaths({
        ...connection.connection,
        remotePaths,
        destinationDirectory,
        operationId,
      });
    },
    [connection.connection, connection.id, addOperation],
  );

  const openRemoteFile = useCallback(
    async (path: string) => {
      await invokeOpenRemoteFile({
        ...connection.connection,
        path,
      });
    },
    [connection.connection],
  );

  const previewRemoteFile = useCallback(
    async (path: string): Promise<ReadRemoteFileResponse> => {
      return invokePreviewRemoteFile({
        ...connection.connection,
        path,
      });
    },
    [connection.connection],
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
