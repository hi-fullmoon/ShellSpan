import { useCallback } from 'react';
import {
  buildRemoteConnectionRequest,
  invokeCopyRemotePath,
  invokeCancelDelete,
  invokeCancelDownload,
  invokeCancelUpload,
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
import { getErrorMessage, getLocalizedErrorMessage } from '@/lib/error';
import { promptForMissingKeychainKey } from '@/lib/keychain-key-prompt';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
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

// Per-pane monotonically increasing request ids for directory listings. Only
// the latest request is allowed to write results back or clear the loading
// flag, so a slow stale response cannot clobber a newer listing.
const directoryListRequestIds = new Map<string, number>();

function nextDirectoryListRequestId(key: string): number {
  const next = (directoryListRequestIds.get(key) ?? 0) + 1;
  directoryListRequestIds.set(key, next);
  return next;
}

function isLatestDirectoryListRequest(key: string, requestId: number): boolean {
  return directoryListRequestIds.get(key) === requestId;
}

async function runWithConfiguredRetries(
  task: () => Promise<void>,
  shouldRetry: () => boolean = () => true,
): Promise<void> {
  const retryCount = useAppStore.getState().sftpRetryCount;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      await task();
      return;
    } catch (error) {
      lastError = error;
      if (!shouldRetry()) throw error;
      if (attempt < retryCount) {
        // Sleep in short slices so a cancellation observed by shouldRetry
        // interrupts the backoff instead of waiting out the full delay.
        const delayMs = 750 * (attempt + 1);
        const sliceMs = 100;
        for (let elapsed = 0; elapsed < delayMs; elapsed += sliceMs) {
          if (!shouldRetry()) throw lastError;
          await new Promise((resolve) =>
            window.setTimeout(resolve, Math.min(sliceMs, delayMs - elapsed)),
          );
        }
      }
    }
  }
  throw lastError;
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
  const updateConnectionRequest = useSftpStore((state) => state.updateConnectionRequest);
  const addOperation = useTransferStore((state) => state.addOperation);
  const markOperationRunning = useTransferStore(
    (state) => state.markOperationRunning,
  );
  const markOperationFailed = useTransferStore(
    (state) => state.markOperationFailed,
  );
  const markOperationCompleted = useTransferStore(
    (state) => state.markOperationCompleted,
  );
  const markOperationCancelled = useTransferStore(
    (state) => state.markOperationCancelled,
  );
  const updateDelete = useTransferStore((state) => state.updateDelete);
  const setOperationUndo = useTransferStore((state) => state.setOperationUndo);

  const loadRemoteDirectory = useCallback(
    async (path?: string) => {
      const requestKey = `${connection.id}:${side}`;
      const requestId = nextDirectoryListRequestId(requestKey);
      const isLatest = () => isLatestDirectoryListRequest(requestKey, requestId);
      setLoading(connection.id, side, true);
      setError(connection.id, side);
      try {
        const listing = await invokeListRemoteDirectory({
          ...remoteConnection,
          path,
        });
        if (!isLatest()) return;
        setPath(connection.id, side, listing.path);
        setEntries(connection.id, side, listing.entries);
      } catch (error) {
        logger.error(`Failed to list remote directory${path ? `: ${path}` : ''}`, error);

        const message = getErrorMessage(error);
        const profileId = side === 'local' ? connection.leftProfileId : connection.profileId;
        if (
          profileId &&
          remoteConnection.authMethod === 'key' &&
          remoteConnection.keychainKeyId &&
          message.toLowerCase().startsWith('keychain key not found:')
        ) {
          const profile = useProfileStore.getState().getProfile(profileId);
          if (profile) {
            const recovered = await promptForMissingKeychainKey(profile);
            if (recovered) {
              const newRequest = buildRemoteConnectionRequest(recovered);
              updateConnectionRequest(connection.id, side, newRequest);
              try {
                const retryListing = await invokeListRemoteDirectory({
                  ...newRequest,
                  path,
                });
                if (!isLatest()) return;
                setPath(connection.id, side, retryListing.path);
                setEntries(connection.id, side, retryListing.entries);
                return;
              } catch (retryError) {
                // Fall through to the shared error path instead of letting the
                // retry failure escape as an unhandled rejection.
                if (!isLatest()) return;
                setError(
                  connection.id,
                  side,
                  getLocalizedErrorMessage(retryError),
                );
                return;
              }
            }
          }
        }

        if (!isLatest()) return;
        setError(
          connection.id,
          side,
          getLocalizedErrorMessage(error),
        );
      } finally {
        if (isLatest()) {
          setLoading(connection.id, side, false);
        }
      }
    },
    [connection.id, connection.leftProfileId, connection.profileId, remoteConnection, setPath, setEntries, setLoading, setError, updateConnectionRequest, side],
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
        cancel: () => invokeCancelDelete(operationId),
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
          // Read the latest connection from the store: the pane may have been
          // reconnected with different credentials since the delete started.
          const latestConnection = useSftpStore
            .getState()
            .connections.find((item) => item.id === connection.id);
          const cleanupConnection = latestConnection
            ? getSftpPaneConnection(latestConnection, side)
            : remoteConnection;
          void Promise.allSettled(
            trashedPaths.map((trashedPath, index) =>
              invokeDeleteRemotePath({
                ...cleanupConnection,
                path: trashedPath.trashPath,
                operationId: `${operationId}-cleanup-${index}`,
              }),
            ),
          ).then((results) => {
            results.forEach((result, index) => {
              if (result.status === 'rejected') {
                logger.error(
                  `Failed to purge trashed path ${trashedPaths[index]?.trashPath}`,
                  result.reason,
                );
              }
            });
          });
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
          getLocalizedErrorMessage(error),
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
      side,
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
    async (localPaths: string[], destinationDirectory: string, operationId = createOperationId(connection.id, 'upload'), conflictPolicies: UploadConflictPolicy[] = []) => {
      const runUpload = async (): Promise<void> => {
        markOperationRunning(operationId);
        try {
          await runWithConfiguredRetries(() =>
            invokeUploadLocalPaths({
              ...remoteConnection,
              destinationDirectory,
              localPaths,
              conflictPolicies,
              operationId,
            }),
          );
          // The backend's final progress event is the only other completion
          // signal; mark completion explicitly in case that event is lost.
          const operation = useTransferStore.getState().operations.find(
            (item) => item.operationId === operationId,
          );
          if (operation?.status === 'cancelling') {
            // The upload finished before the cancel request took effect.
            markOperationCancelled(operationId);
          } else {
            markOperationCompleted(operationId);
          }
        } catch (error) {
          markOperationFailed(
            operationId,
            getLocalizedErrorMessage(error),
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
        cancel: () => invokeCancelUpload(operationId),
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
      markOperationCompleted,
      markOperationCancelled,
    ],
  );

  const downloadRemotePaths = useCallback(
    async (remotePaths: string[], destinationDirectory: string, operationId = createOperationId(connection.id, 'download')) => {
      const runDownload = async (): Promise<void> => {
        try {
          await runWithConfiguredRetries(
            () => invokeDownloadRemotePaths({
              ...remoteConnection,
              remotePaths,
              destinationDirectory,
              operationId,
            }),
            () =>
              useTransferStore.getState().operations.find(
                (item) => item.operationId === operationId,
              )?.status !== 'cancelling',
          );
          // The backend's final progress event is the only other completion
          // signal; mark completion explicitly in case that event is lost.
          const operation = useTransferStore.getState().operations.find(
            (item) => item.operationId === operationId,
          );
          if (operation?.status === 'cancelling') {
            // The download finished before the cancel request took effect.
            markOperationCancelled(operationId);
          } else {
            markOperationCompleted(operationId);
          }
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
            getLocalizedErrorMessage(error),
          );
          throw error;
        }
      };
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
        retry: runDownload,
        cancel: () => invokeCancelDownload(operationId),
      });
      await runDownload();
    },
    [remoteConnection, remoteConnectionKey, connection.id, addOperation, markOperationFailed, markOperationCompleted, markOperationCancelled],
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
