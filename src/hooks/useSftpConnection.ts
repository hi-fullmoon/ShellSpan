import { useCallback } from 'react';
import {
  buildRemoteConnectionRequest,
  invokeCopyRemotePath,
  invokeCancelDelete,
  invokeCancelDownload,
  invokeCancelRemoteCopy,
  invokeCancelUpload,
  invokeCreateRemoteEntry,
  invokeDeleteRemotePath,
  invokeDownloadRemotePaths,
  invokeListRemoteDirectory,
  invokeOpenRemoteFile,
  invokePreviewRemoteFile,
  invokeRenameRemotePath,
  invokeResolveRemoteEntryOwners,
  invokeUpdateRemotePermissions,
  invokeUploadLocalPaths,
} from '@/lib/tauri';
import {
  getCachedDirectoryListing,
  invalidateDirectoryListingCache,
  setCachedDirectoryListing,
} from '@/lib/directory-listing-cache';
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
import { normalizePortablePath } from '@/lib/path-utils';
import { useAppStore } from '@/stores/appStore';
import { useProfileStore } from '@/stores/profileStore';
import {
  isLatestDirectoryListRequest,
  nextDirectoryListRequestId,
} from '@/hooks/utils';
import type { SftpSide } from '@/stores/sftpStore';
import type {
  ReadRemoteFileResponse,
  RemoteDirectoryListing,
  RemoteFileEntry,
  TransferBatchResult,
  UploadConflictPolicy,
} from '@/types';

const logger = createLogger('sftp');

function createOperationId(connectionId: string, kind: string): string {
  return `${connectionId}-${kind}-${crypto.randomUUID()}`;
}

function pathBaseName(path: string): string {
  const normalized = normalizePortablePath(path).replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() ?? path;
}

function remoteJoin(directory: string, name: string): string {
  const base = directory === '/' ? '' : directory.replace(/\/+$/, '');
  return `${base}/${name}`;
}

function failedTransferItems(result: TransferBatchResult) {
  return result.items.filter((item) => item.status === 'failed');
}

function summarizeFailedItems(kind: 'upload' | 'download', result: TransferBatchResult): string | null {
  const failed = failedTransferItems(result);
  if (!failed.length) return null;
  const details = failed
    .map((item) => `${item.sourcePath}: ${item.error ?? 'unknown error'}`)
    .join('; ');
  return `failed to ${kind} ${failed.length} of ${result.items.length} entries: ${details}`;
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
  downloadRemotePaths: (remotePaths: string[], destinationDirectory: string, operationId?: string, conflictPolicies?: UploadConflictPolicy[]) => Promise<void>;
  openRemoteFile: (path: string) => Promise<void>;
  previewRemoteFile: (path: string) => Promise<ReadRemoteFileResponse>;
  invalidatePaneListingCache: () => void;
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

  // Fills in owner/group names after the listing is already on screen: ids
  // that miss the backend identity cache are resolved via a single remote
  // exec, then merged into the entries if the pane is still on this path.
  const resolveEntryOwners = useCallback(
    async (listing: RemoteDirectoryListing, isLatest: () => boolean) => {
      const ownerIds = [
        ...new Set(
          listing.entries
            .filter((entry) => entry.ownerUid !== undefined && !entry.ownerName)
            .map((entry) => entry.ownerUid as number),
        ),
      ];
      const groupIds = [
        ...new Set(
          listing.entries
            .filter((entry) => entry.groupGid !== undefined && !entry.groupName)
            .map((entry) => entry.groupGid as number),
        ),
      ];
      if (ownerIds.length === 0 && groupIds.length === 0) return;
      try {
        const owners = await invokeResolveRemoteEntryOwners({
          ...remoteConnection,
          ownerIds,
          groupIds,
        });
        if (!isLatest()) return;
        const current = useSftpStore
          .getState()
          .connections.find((item) => item.id === connection.id);
        if (!current) return;
        const currentPath = side === 'local' ? current.localPath : current.remotePath;
        if (currentPath !== listing.path) return;
        const currentEntries = (side === 'local'
          ? current.localEntries
          : current.remoteEntries) as RemoteFileEntry[];
        const merged = currentEntries.map((entry) => ({
          ...entry,
          ownerName:
            entry.ownerName ??
            (entry.ownerUid !== undefined ? owners.ownerNames[entry.ownerUid] : undefined),
          groupName:
            entry.groupName ??
            (entry.groupGid !== undefined ? owners.groupNames[entry.groupGid] : undefined),
        }));
        setEntries(connection.id, side, merged);
        // Keep the directory cache in sync so revisiting this path shows the
        // resolved names instantly too.
        const requestKey = `${connection.id}:${side}`;
        setCachedDirectoryListing(`${requestKey}:${listing.path}`, {
          ...listing,
          entries: merged,
        });
      } catch (error) {
        logger.warn('Failed to resolve remote entry owners', error);
      }
    },
    [connection.id, remoteConnection, setEntries, side],
  );

  const loadRemoteDirectory = useCallback(
    async (path?: string) => {
      const requestKey = `${connection.id}:${side}`;
      const requestId = nextDirectoryListRequestId(requestKey);
      const isLatest = () => isLatestDirectoryListRequest(requestKey, requestId);
      const cacheKey = `${requestKey}:${path ?? ''}`;
      const cached = getCachedDirectoryListing(cacheKey);
      if (cached) {
        // Render the cached listing instantly and revalidate below; only a
        // cold load shows the loading state.
        setPath(connection.id, side, cached.path);
        setEntries(connection.id, side, cached.entries);
      } else {
        setLoading(connection.id, side, true);
      }
      setError(connection.id, side);
      const applyListing = (listing: RemoteDirectoryListing): void => {
        setPath(connection.id, side, listing.path);
        setEntries(connection.id, side, listing.entries);
        setCachedDirectoryListing(cacheKey, listing);
        setCachedDirectoryListing(`${requestKey}:${listing.path}`, listing);
        void resolveEntryOwners(listing, isLatest);
      };
      try {
        const listing = await invokeListRemoteDirectory({
          ...remoteConnection,
          path,
        });
        if (!isLatest()) return;
        applyListing(listing);
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
                applyListing(retryListing);
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
    [connection.id, connection.leftProfileId, connection.profileId, remoteConnection, setPath, setEntries, setLoading, setError, updateConnectionRequest, resolveEntryOwners, side],
  );

  // Mutating operations invalidate this pane's cached listings up front so
  // the reload after the mutation never flashes the pre-mutation entries.
  const invalidatePaneListingCache = useCallback((): void => {
    invalidateDirectoryListingCache(`${connection.id}:${side}:`);
  }, [connection.id, side]);

  const createRemoteEntry = useCallback(
    async (parentPath: string, name: string, kind: 'file' | 'directory') => {
      invalidatePaneListingCache();
      await invokeCreateRemoteEntry({
        ...remoteConnection,
        parentPath,
        name,
        kind,
      });
      await loadRemoteDirectory(panePath);
    },
    [remoteConnection, panePath, loadRemoteDirectory, invalidatePaneListingCache],
  );

  const renameRemotePath = useCallback(
    async (path: string, newName: string) => {
      invalidatePaneListingCache();
      await invokeRenameRemotePath({
        ...remoteConnection,
        path,
        newName,
      });
      await loadRemoteDirectory(panePath);
    },
    [remoteConnection, panePath, loadRemoteDirectory, invalidatePaneListingCache],
  );

  const copyRemotePath = useCallback(
    async (sourcePath: string, destinationDirectory: string) => {
      invalidatePaneListingCache();
      const operationId = createOperationId(connection.id, 'copy');
      const runCopy = async (): Promise<void> => {
        markOperationRunning(operationId);
        try {
          await invokeCopyRemotePath({
            ...remoteConnection,
            sourcePath,
            destinationDirectory,
            operationId,
          });
          markOperationCompleted(operationId);
          await loadRemoteDirectory(panePath);
        } catch (copyError) {
          const operation = useTransferStore.getState().operations.find(
            (item) => item.operationId === operationId,
          );
          if (operation?.status === 'cancelling') {
            // The backend observed the cancel flag, removed the staged
            // `.part` file and reported the copy as cancelled.
            markOperationCancelled(operationId);
            return;
          }
          markOperationFailed(
            operationId,
            getLocalizedErrorMessage(copyError),
          );
          throw copyError;
        }
      };
      const sourceName = sourcePath.replace(/\\/g, '/').split('/').pop() ?? sourcePath;
      const destinationBase = destinationDirectory === '/' ? '' : destinationDirectory.replace(/\/+$/, '');
      const destinationPath = `${destinationBase}/${sourceName}`;
      addOperation({
        operationId,
        kind: 'remote-copy',
        connectionId: remoteConnectionKey,
        paths: [sourcePath],
        pathScopes: [
          { connectionId: remoteConnectionKey, paths: [sourcePath] },
          { connectionId: remoteConnectionKey, paths: [destinationPath] },
        ],
        currentPath: sourcePath,
        totalBytes: 0,
        processedBytes: 0,
        totalSteps: 1,
        completedSteps: 0,
        status: 'running',
        retry: runCopy,
        cancel: () => invokeCancelRemoteCopy(operationId),
      });
      await runCopy();
    },
    [remoteConnection, remoteConnectionKey, connection.id, panePath, loadRemoteDirectory, addOperation, markOperationRunning, markOperationFailed, markOperationCompleted, markOperationCancelled],
  );

  const deleteRemotePaths = useCallback(
    async (paths: string[]) => {
      invalidatePaneListingCache();
      const operationId = createOperationId(connection.id, 'delete');
      addOperation({
        operationId,
        kind: 'delete',
        connectionId: remoteConnectionKey,
        paths,
        currentPath: paths[0],
        totalBytes: 0,
        processedBytes: 0,
        // The backend deletes single-pass without a pre-count; the total grows
        // rsync-style as entries are discovered, starting from 0.
        totalSteps: 0,
        completedSteps: 0,
        status: 'running',
        cancel: () => invokeCancelDelete(operationId),
      });
      try {
        await invokeDeleteRemotePath({
          ...remoteConnection,
          paths,
          operationId,
        });
        // Mark completion explicitly: queued backend progress events can be
        // delivered after the invoke resolves and would otherwise
        // regress the counters, leaving the paths "busy" forever.
        markOperationCompleted(operationId);
        await loadRemoteDirectory(panePath);
      } catch (error) {
        const operation = useTransferStore.getState().operations.find(
          (item) => item.operationId === operationId,
        );
        if (operation?.status === 'cancelling') {
          // The backend observed the cancel flag and reported the delete as
          // cancelled; paths already deleted stay deleted.
          markOperationCancelled(operationId);
          await loadRemoteDirectory(panePath);
          return;
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
      markOperationCompleted,
      markOperationCancelled,
    ],
  );

  const updateRemotePermissions = useCallback(
    async (path: string, permissions: number) => {
      invalidatePaneListingCache();
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
      let currentLocalPaths = localPaths;
      let currentConflictPolicies = conflictPolicies;
      let runUpload: () => Promise<void>;
      const setUploadOperationRunning = () => {
        const currentTargetPaths = currentLocalPaths.map((path) =>
          remoteJoin(destinationDirectory, pathBaseName(path)),
        );
        addOperation({
          operationId,
          kind: 'upload',
          connectionId: remoteConnectionKey,
          paths: currentTargetPaths,
          currentPath: currentLocalPaths[0],
          totalBytes: 0,
          processedBytes: 0,
          totalSteps: currentLocalPaths.length,
          completedSteps: 0,
          status: 'running',
          retry: runUpload,
          cancel: () => invokeCancelUpload(operationId),
        });
      };
      runUpload = async (): Promise<void> => {
        markOperationRunning(operationId);
        try {
          setUploadOperationRunning();
          await runWithConfiguredRetries(
            async () => {
              const batchResult = await invokeUploadLocalPaths({
                ...remoteConnection,
                destinationDirectory,
                localPaths: currentLocalPaths,
                conflictPolicies: currentConflictPolicies,
                operationId,
              });
              const failureMessage = summarizeFailedItems('upload', batchResult);
              if (failureMessage) {
                const failedSources = new Set(
                  failedTransferItems(batchResult).map((item) =>
                    normalizePortablePath(item.sourcePath),
                  ),
                );
                const previousLocalPaths = currentLocalPaths;
                const previousPolicies = currentConflictPolicies;
                const nextLocalPaths = previousLocalPaths.filter((path) =>
                  failedSources.has(normalizePortablePath(path)),
                );
                if (nextLocalPaths.length > 0) {
                  currentLocalPaths = nextLocalPaths;
                  currentConflictPolicies = previousPolicies.filter((_, index) =>
                    failedSources.has(normalizePortablePath(previousLocalPaths[index] ?? '')),
                  );
                  setUploadOperationRunning();
                }
                throw new Error(failureMessage);
              }
            },
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
            // The upload finished before the cancel request took effect.
            markOperationCancelled(operationId);
          } else {
            markOperationCompleted(operationId);
          }
        } catch (error) {
          const operation = useTransferStore.getState().operations.find(
            (item) => item.operationId === operationId,
          );
          if (operation?.status === 'cancelling') {
            markOperationCancelled(operationId);
            return;
          }
          markOperationFailed(
            operationId,
            getLocalizedErrorMessage(error),
          );
          throw error;
        }
      };

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
    async (remotePaths: string[], destinationDirectory: string, operationId = createOperationId(connection.id, 'download'), conflictPolicies: UploadConflictPolicy[] = []) => {
      let currentRemotePaths = remotePaths;
      let currentConflictPolicies = conflictPolicies;
      let runDownload: () => Promise<void>;
      const setDownloadOperationRunning = () => {
        addOperation({
          operationId,
          kind: 'download',
          connectionId: remoteConnectionKey,
          paths: currentRemotePaths,
          currentPath: currentRemotePaths[0],
          totalBytes: 0,
          processedBytes: 0,
          totalSteps: currentRemotePaths.length,
          completedSteps: 0,
          status: 'running',
          retry: runDownload,
          cancel: () => invokeCancelDownload(operationId),
        });
      };
      runDownload = async (): Promise<void> => {
        try {
          setDownloadOperationRunning();
          await runWithConfiguredRetries(
            async () => {
              const batchResult = await invokeDownloadRemotePaths({
                ...remoteConnection,
                remotePaths: currentRemotePaths,
                destinationDirectory,
                conflictPolicies: currentConflictPolicies,
                operationId,
              });
              const failureMessage = summarizeFailedItems('download', batchResult);
              if (failureMessage) {
                const failedSources = new Set(
                  failedTransferItems(batchResult).map((item) =>
                    normalizePortablePath(item.sourcePath),
                  ),
                );
                const previousRemotePaths = currentRemotePaths;
                const previousPolicies = currentConflictPolicies;
                const nextRemotePaths = previousRemotePaths.filter((path) =>
                  failedSources.has(normalizePortablePath(path)),
                );
                if (nextRemotePaths.length > 0) {
                  currentRemotePaths = nextRemotePaths;
                  currentConflictPolicies = previousPolicies.filter((_, index) =>
                    failedSources.has(normalizePortablePath(previousRemotePaths[index] ?? '')),
                  );
                  setDownloadOperationRunning();
                }
                throw new Error(failureMessage);
              }
            },
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
    invalidatePaneListingCache,
  };
}
