import { useCallback, useMemo, useRef, useState } from 'react';
import {
  invokeCopyLocalPaths,
  invokeCancelRemoteCopy,
  invokeCopyRemoteToRemote,
  invokePickLocalFiles,
  invokePickLocalFolder,
  invokeRenameLocalPath,
  invokeTrashLocalPaths,
  invokePasteLocalPaths,
} from '@/lib/tauri';
import { useLocalDirectory } from '@/hooks/useLocalDirectory';
import { parentPortablePath } from '@/lib/path-utils';
import { useSftpConnection } from '@/hooks/useSftpConnection';
import { useToast } from '@/hooks/useToast';
import { useI18n } from '@/hooks/useI18n';
import {
  getSftpPaneConnection,
  getSftpPaneConnectionKey,
  useSftpStore,
  type SftpConnection,
  type SftpSide,
} from '@/stores/sftpStore';
import {
  runPathOperation,
  useTransferStore,
  type PathOperationScope,
} from '@/stores/transferStore';
import { createLogger } from '@/lib/logger';
import { getLocalizedErrorMessage, getToastErrorMessage } from '@/lib/error';
import type { FileEntry } from '@/components/sftp/utils';
import type { ReadRemoteFileResponse, RemoteFileEntry, RemoteFileKind, UploadConflictPolicy } from '@/types';
import { useAppStore } from '@/stores/appStore';

const logger = createLogger('sftp');

export type UploadConflictAction = 'overwrite' | 'replace' | 'skip' | 'cancel';

export interface PendingUploadConflict {
  localPath: string;
  targetName: string;
  existingKind: RemoteFileKind;
  remainingConflicts: number;
}

export type SftpPreviewTarget = Pick<FileEntry, 'path' | 'name' | 'size'>;

export interface UseSftpPaneActionsResult {
  createMode: 'file' | 'folder' | null;
  renameTarget?: FileEntry;
  permissionsTarget?: RemoteFileEntry;
  propertiesTarget?: FileEntry;
  previewTarget?: SftpPreviewTarget;
  previewContent?: ReadRemoteFileResponse;
  hasLocalClipboard: boolean;
  onOpen: (entry: FileEntry) => void;
  onOpenWithDefaultEditor: (entry?: Pick<FileEntry, 'path' | 'kind'>) => Promise<void>;
  onPreview: (entry?: FileEntry) => Promise<void>;
  onDownload: (entry?: FileEntry) => Promise<void>;
  onBatchDownload: () => Promise<void>;
  uploadWithPolicies: (localPaths: string[], destinationDirectory: string, policies: UploadConflictPolicy[], operationId?: string) => Promise<void>;
  copyWithPolicies: (sourcePaths: string[], destinationDirectory: string, policies: UploadConflictPolicy[], operationId?: string) => Promise<void>;
  onCopy: (entry?: FileEntry) => void;
  onPaste: () => Promise<void>;
  onRename: (entry?: FileEntry) => void;
  onDelete: (entries?: FileEntry[]) => Promise<void>;
  onCopyName: (entry?: FileEntry) => Promise<void>;
  onCopyPath: (entry?: FileEntry) => Promise<void>;
  onCopyContainingDirectory: (entry?: FileEntry) => Promise<void>;
  onNewFile: () => void;
  onNewFolder: () => void;
  onUploadFiles: () => Promise<void>;
  onUploadFolders: () => Promise<void>;
  onEditPermissions: (entry?: FileEntry) => void;
  onProperties: (entry?: FileEntry) => void;
  onToggleBookmark: (path?: string) => void;
  onRefresh: () => Promise<void>;
  onToggleBatchMode: () => void;
  onCopyCurrentDirectoryPath: () => Promise<void>;
  setCreateMode: (mode: 'file' | 'folder' | null) => void;
  setRenameTarget: (entry?: FileEntry) => void;
  setPermissionsTarget: (entry?: RemoteFileEntry) => void;
  setPropertiesTarget: (entry?: FileEntry) => void;
  closePreview: () => void;
  handleCreate: (name: string, kind: 'file' | 'directory') => Promise<void>;
  handleRename: (newName: string) => Promise<void>;
  handlePermissions: (permissions: number) => Promise<void>;
}

export function parentDirectoryPath(path: string): string {
  return parentPortablePath(path);
}

function remoteDestinationPath(directory: string, sourcePath: string): string {
  const normalizedSource = sourcePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const name = normalizedSource.split('/').filter(Boolean).pop() ?? sourcePath;
  const base = directory === '/' ? '' : directory.replace(/\/+$/, '');
  return `${base}/${name}`;
}

function writeClipboardText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value);
  }
  return new Promise((resolve, reject) => {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.append(textarea);
    textarea.select();
    let succeeded = false;
    try {
      succeeded = document.execCommand('copy');
    } catch {
      succeeded = false;
    }
    textarea.remove();
    if (succeeded) {
      resolve();
    } else {
      reject(new Error('Copy to clipboard failed'));
    }
  });
}

export function useSftpPaneActions(
  connection: SftpConnection,
  side: SftpSide,
  localMode?: boolean,
): UseSftpPaneActionsResult {
  const isLocal = localMode ?? side === 'local';
  const path = side === 'local' ? connection.localPath : connection.remotePath;
  const entries = side === 'local' ? connection.localEntries : connection.remoteEntries;
  const pane = side === 'local' ? connection.localPane : connection.remotePane;
  const remoteBookmarks = connection.remoteBookmarks[side];
  const remoteConnection = getSftpPaneConnection(connection, side);
  const remoteConnectionKey = getSftpPaneConnectionKey(connection, side);

  const { loadLocalDirectory, openLocalPath, previewLocalFile } = useLocalDirectory(connection, side);
  const {
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
  } = useSftpConnection(connection, side);
  const {
    addOperation,
    markOperationCompleted,
    markOperationCancelled,
    markOperationFailed,
    markOperationRunning,
    removeOperation,
  } = useTransferStore();
  const { error, info, success } = useToast();
  const { t } = useI18n();

  const setPaneState = useSftpStore((state) => state.setPaneState);
  const setRemoteClipboard = useSftpStore((state) => state.setRemoteClipboard);
  const addRemoteBookmark = useSftpStore((state) => state.addRemoteBookmark);
  const removeRemoteBookmark = useSftpStore((state) => state.removeRemoteBookmark);
  // App-global local clipboard: copy in one local pane, paste in any other.
  const localClipboard = useSftpStore((state) => state.localClipboard);
  const setLocalClipboard = useSftpStore((state) => state.setLocalClipboard);

  const [createMode, setCreateMode] = useState<'file' | 'folder' | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileEntry | undefined>(undefined);
  const [permissionsTarget, setPermissionsTarget] = useState<RemoteFileEntry | undefined>(undefined);
  const [propertiesTarget, setPropertiesTarget] = useState<FileEntry | undefined>(undefined);
  const [previewTarget, setPreviewTarget] = useState<SftpPreviewTarget | undefined>(undefined);
  const [previewContent, setPreviewContent] = useState<ReadRemoteFileResponse | undefined>(undefined);
  const previewRequestIdRef = useRef(0);

  const selectedPaths = pane.selectedPaths;
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedPaths.includes(entry.path)),
    [entries, selectedPaths],
  );

  const runAfterPathsIdle = useCallback(
    <T,>(
      scopes: PathOperationScope[],
      task: () => Promise<T> | T,
      queueKey?: string,
    ) =>
      runPathOperation(scopes, task, {
        ownerId: connection.id,
        queueKey,
        onQueued: () => info(t('sftp.transfer.queued')),
      }),
    [connection.id, info, t],
  );

  const reload = useCallback(async () => {
    if (isLocal) {
      await loadLocalDirectory(path);
    } else {
      await loadRemoteDirectory(path);
    }
  }, [isLocal, loadLocalDirectory, loadRemoteDirectory, path]);

  const clearSelection = useCallback(() => {
    setPaneState(connection.id, side, { selectedPaths: [] });
  }, [connection.id, setPaneState, side]);

  const onOpen = useCallback(
    (entry: FileEntry) => {
      if (entry.kind !== 'directory') return;
      if (isLocal) {
        loadLocalDirectory(entry.path);
      } else {
        loadRemoteDirectory(entry.path);
      }
      clearSelection();
    },
    [isLocal, loadLocalDirectory, loadRemoteDirectory, clearSelection],
  );

  const onOpenWithDefaultEditor = useCallback(
    async (entry?: Pick<FileEntry, 'path' | 'kind'>) => {
      const target = entry ?? selectedEntries[0];
      if (!target || target.kind === 'directory') return;
      try {
        if (isLocal) {
          await openLocalPath(target.path);
        } else {
          await openRemoteFile(target.path);
        }
      } catch (err) {
        logger.warn(`Failed to open ${isLocal ? 'local' : 'remote'} file: ${target.path}`, err);
        error(getToastErrorMessage(err));
      }
    },
    [isLocal, openLocalPath, openRemoteFile, selectedEntries, error],
  );

  const onPreview = useCallback(
    async (entry?: FileEntry) => {
      const target = entry ?? selectedEntries[0];
      if (!target || target.kind === 'directory') return;
      const requestId = ++previewRequestIdRef.current;
      setPreviewTarget({ path: target.path, name: target.name, size: target.size });
      setPreviewContent(undefined);
      try {
        const content = isLocal
          ? await previewLocalFile(target.path)
          : await previewRemoteFile(target.path);
        if (previewRequestIdRef.current === requestId) {
          setPreviewTarget({ path: content.path, name: content.name, size: content.size });
          setPreviewContent(content);
        }
      } catch (err) {
        if (previewRequestIdRef.current !== requestId) return;
        setPreviewTarget(undefined);
        setPreviewContent(undefined);
        logger.warn(`Failed to preview ${isLocal ? 'local' : 'remote'} file: ${target.path}`, err);
        error(getToastErrorMessage(err));
      }
    },
    [isLocal, previewLocalFile, previewRemoteFile, selectedEntries, error],
  );

  const closePreview = useCallback(() => {
    previewRequestIdRef.current += 1;
    setPreviewTarget(undefined);
    setPreviewContent(undefined);
  }, []);

  const onDownload = useCallback(
    async (entry?: FileEntry) => {
      if (isLocal) return;
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      const targetScope = [{ connectionId: remoteConnectionKey, paths: [target.path] }];
      try {
        const configuredDirectory = useAppStore.getState().sftpDownloadDirectory;
        const folders = configuredDirectory ? [configuredDirectory] : await invokePickLocalFolder();
        if (!folders.length) return;
        await runAfterPathsIdle(targetScope, () =>
          downloadRemotePaths([target.path], folders[0]),
        );
      } catch (err) {
        logger.warn(`Failed to download: ${target.path}`, err);
        error(getToastErrorMessage(err));
      }
    },
    [downloadRemotePaths, isLocal, remoteConnectionKey, runAfterPathsIdle, selectedEntries, error],
  );

  const onBatchDownload = useCallback(
    async () => {
      if (isLocal || !selectedEntries.length) return;
      const selectedRemotePaths = selectedEntries.map((entry) => entry.path);
      const selectedScopes = [{ connectionId: remoteConnectionKey, paths: selectedRemotePaths }];
      try {
        const configuredDirectory = useAppStore.getState().sftpDownloadDirectory;
        const folders = configuredDirectory ? [configuredDirectory] : await invokePickLocalFolder();
        if (!folders.length) return;
        await runAfterPathsIdle(selectedScopes, () =>
          downloadRemotePaths(selectedRemotePaths, folders[0]),
        );
      } catch (err) {
        logger.warn('Batch download failed', err);
        error(getToastErrorMessage(err));
      }
    },
    [downloadRemotePaths, isLocal, remoteConnectionKey, runAfterPathsIdle, selectedEntries, error],
  );

  const onCopy = useCallback(
    (entry?: FileEntry) => {
      if (isLocal) {
        const targets = entry ? [entry] : selectedEntries;
        if (!targets.length) return;
        setLocalClipboard(targets);
        success(`Copied ${targets.length} item(s)`);
        return;
      }
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      setRemoteClipboard(connection.id, {
        sourcePath: target.path,
        sourceName: target.name,
        kind: target.kind,
        sourceSide: side,
        sourceConnection: remoteConnection,
        sourceConnectionKey: remoteConnectionKey,
      });
      success(`Copied ${target.name}`);
    },
    [connection.id, isLocal, remoteConnection, remoteConnectionKey, selectedEntries, setRemoteClipboard, side, success],
  );

  const onPaste = useCallback(async () => {
    if (isLocal) {
      if (!localClipboard.length) return;
      try {
        await invokePasteLocalPaths(
          localClipboard.map((entry) => entry.path),
          path,
          t('sftp.copySuffix'),
        );
        await reload();
        clearSelection();
      } catch (err) {
        logger.warn('Local paste failed', err);
        error(getToastErrorMessage(err));
      }
      return;
    }
    if (!connection.remoteClipboard) return;
    const clipboard = connection.remoteClipboard;
    const destinationBase = path === '/' ? '' : path.replace(/\/+$/, '');
    const destinationPath = `${destinationBase}/${clipboard.sourceName}`;
    const transferScopes = [
      { connectionId: clipboard.sourceConnectionKey, paths: [clipboard.sourcePath] },
      { connectionId: remoteConnectionKey, paths: [destinationPath] },
    ];
    try {
      await runAfterPathsIdle(transferScopes, async () => {
        if (clipboard.sourceConnectionKey === remoteConnectionKey) {
          await copyRemotePath(clipboard.sourcePath, path);
        } else {
          const operationId = `${connection.id}-remote-copy-${crypto.randomUUID()}`;
          const request = {
            sourceConnection: clipboard.sourceConnection,
            destinationConnection: remoteConnection,
            sourcePaths: [clipboard.sourcePath],
            destinationDirectory: path,
            conflictPolicies: ['fail'] as UploadConflictPolicy[],
            operationId,
          };
          const runRemoteCopy = async (): Promise<void> => {
            markOperationRunning(operationId);
            try {
              await invokeCopyRemoteToRemote(request);
              markOperationCompleted(operationId);
              void reload();
            } catch (copyError) {
              const operation = useTransferStore.getState().operations.find(
                (item) => item.operationId === operationId,
              );
              if (operation?.status === 'cancelling') {
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
          addOperation({
            operationId,
            kind: 'remote-copy',
            ownerId: connection.id,
            connectionId: clipboard.sourceConnectionKey,
            paths: [clipboard.sourcePath],
            pathScopes: transferScopes,
            currentPath: clipboard.sourcePath,
            totalBytes: 0,
            processedBytes: 0,
            totalSteps: 1,
            completedSteps: 0,
            status: 'running',
            retry: runRemoteCopy,
            cancel: () => invokeCancelRemoteCopy(operationId),
          });
          await runRemoteCopy();
        }
      });
      clearSelection();
    } catch (err) {
      logger.warn('Paste failed', err);
      error(getToastErrorMessage(err));
    }
  }, [addOperation, clearSelection, connection.id, connection.remoteClipboard, copyRemotePath, isLocal, localClipboard, markOperationCancelled, markOperationCompleted, markOperationFailed, markOperationRunning, path, runAfterPathsIdle, reload, remoteConnection, remoteConnectionKey, t, error]);

  const onCopyName = useCallback(
    async (entry?: FileEntry) => {
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      try {
        await writeClipboardText(target.name);
        success('Copied name');
      } catch (err) {
        logger.warn('Failed to copy name', err);
        error(t('sftp.feedback.copyNameFailed'));
      }
    },
    [selectedEntries, error, success, t],
  );

  const onCopyPath = useCallback(
    async (entry?: FileEntry) => {
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      try {
        await writeClipboardText(target.path);
        success('Copied path');
      } catch (err) {
        logger.warn('Failed to copy path', err);
        error(t('sftp.feedback.copyPathFailed'));
      }
    },
    [selectedEntries, error, success, t],
  );

  const onCopyContainingDirectory = useCallback(
    async (entry?: FileEntry) => {
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      const dir = target.kind === 'directory' ? target.path : parentDirectoryPath(target.path);
      try {
        await writeClipboardText(dir);
        success('Copied directory path');
      } catch (err) {
        logger.warn('Failed to copy directory path', err);
        error(t('sftp.feedback.copyDirectoryFailed'));
      }
    },
    [selectedEntries, error, success, t],
  );

  const onCopyCurrentDirectoryPath = useCallback(async () => {
    if (!path) return;
    try {
      await writeClipboardText(path);
      success('Copied current directory path');
    } catch (err) {
      logger.warn('Failed to copy current directory path', err);
      error(t('sftp.feedback.copyCurrentDirectoryFailed'));
    }
  }, [path, error, success, t]);

  const onNewFile = useCallback(() => {
    if (isLocal) return;
    setCreateMode('file');
  }, [isLocal]);

  const onNewFolder = useCallback(() => {
    if (isLocal) return;
    setCreateMode('folder');
  }, [isLocal]);

  const handleCreate = useCallback(
    async (name: string, kind: 'file' | 'directory') => {
      if (isLocal) return;
      try {
        await createRemoteEntry(path, name, kind);
        clearSelection();
      } catch (err) {
        logger.warn(`Failed to create ${kind}: ${name}`, err);
        error(getToastErrorMessage(err));
      } finally {
        setCreateMode(null);
      }
    },
    [clearSelection, createRemoteEntry, isLocal, path, error],
  );

  const onRename = useCallback(
    (entry?: FileEntry) => {
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      setRenameTarget(target);
    },
    [selectedEntries],
  );

  const handleRename = useCallback(
    async (newName: string) => {
      if (!renameTarget) return;
      try {
        if (isLocal) {
          await invokeRenameLocalPath(renameTarget.path, newName);
          await reload();
        } else {
          await runAfterPathsIdle(
            [{ connectionId: remoteConnectionKey, paths: [renameTarget.path] }],
            () => renameRemotePath(renameTarget.path, newName),
          );
        }
        clearSelection();
      } catch (err) {
        logger.warn(`Failed to rename: ${renameTarget.path}`, err);
        error(getToastErrorMessage(err));
      } finally {
        setRenameTarget(undefined);
      }
    },
    [clearSelection, isLocal, runAfterPathsIdle, remoteConnectionKey, renameRemotePath, renameTarget, reload, error],
  );

  const onDelete = useCallback(
    async (entriesToDelete?: FileEntry[]) => {
      const targets = entriesToDelete?.length ? entriesToDelete : selectedEntries;
      if (!targets.length) return;
      if (isLocal) {
        try {
          await invokeTrashLocalPaths(targets.map((entry) => entry.path));
          await reload();
          clearSelection();
        } catch (err) {
          logger.warn('Failed to trash local paths', err);
          error(getToastErrorMessage(err));
        }
        return;
      }
      try {
        const targetPaths = targets.map((entry) => entry.path);
        await runAfterPathsIdle(
          [{ connectionId: remoteConnectionKey, paths: targetPaths }],
          () => deleteRemotePaths(targetPaths),
        );
        clearSelection();
      } catch (err) {
        logger.warn('Failed to delete remote paths', err);
        error(getToastErrorMessage(err));
      }
    },
    [clearSelection, deleteRemotePaths, isLocal, runAfterPathsIdle, remoteConnectionKey, selectedEntries, error],
  );

  const onUploadFiles = useCallback(async () => {
    if (isLocal) return;
    try {
      const files = await invokePickLocalFiles();
      if (!files.length) return;
      const defaultPolicy = useAppStore.getState().sftpConflictPolicy;
      const policies: UploadConflictPolicy[] = files.map(() =>
        defaultPolicy === 'ask' ? 'fail' : defaultPolicy,
      );
      const targetPaths = files.map((file) => remoteDestinationPath(path, file));
      await runAfterPathsIdle(
        [{ connectionId: remoteConnectionKey, paths: targetPaths }],
        () => uploadLocalPaths(files, path, undefined, policies),
      );
      await reload();
      clearSelection();
    } catch (err) {
      logger.warn('Failed to upload files', err);
      error(getToastErrorMessage(err));
    }
  }, [clearSelection, isLocal, path, reload, remoteConnectionKey, runAfterPathsIdle, uploadLocalPaths, error]);

  const onUploadFolders = useCallback(async () => {
    if (isLocal) return;
    try {
      const folders = await invokePickLocalFolder();
      if (!folders.length) return;
      const defaultPolicy = useAppStore.getState().sftpConflictPolicy;
      const policies: UploadConflictPolicy[] = folders.map(() =>
        defaultPolicy === 'ask' ? 'fail' : defaultPolicy,
      );
      const targetPaths = folders.map((folder) => remoteDestinationPath(path, folder));
      await runAfterPathsIdle(
        [{ connectionId: remoteConnectionKey, paths: targetPaths }],
        () => uploadLocalPaths(folders, path, undefined, policies),
      );
      await reload();
      clearSelection();
    } catch (err) {
      logger.warn('Failed to upload folders', err);
      error(getToastErrorMessage(err));
    }
  }, [clearSelection, isLocal, path, reload, remoteConnectionKey, runAfterPathsIdle, uploadLocalPaths, error]);

  const uploadWithPolicies = useCallback(
    async (localPaths: string[], destinationDirectory: string, policies: UploadConflictPolicy[], operationId?: string) => {
      if (isLocal) return;
      try {
        // A queued batch passes its pending row's id so the real operation
        // replaces that row in place; undefined lets uploadLocalPaths mint one.
        const targetPaths = localPaths.map((localPath) =>
          remoteDestinationPath(destinationDirectory, localPath),
        );
        await runAfterPathsIdle(
          [{ connectionId: remoteConnectionKey, paths: targetPaths }],
          () => uploadLocalPaths(localPaths, destinationDirectory, operationId, policies),
          operationId,
        );
      } catch (err) {
        logger.warn('Upload with conflict policies failed', err);
        error(getToastErrorMessage(err));
      }
    },
    [isLocal, remoteConnectionKey, runAfterPathsIdle, uploadLocalPaths, error],
  );

  const copyWithPolicies = useCallback(
    async (sourcePaths: string[], destinationDirectory: string, policies: UploadConflictPolicy[], operationId?: string) => {
      if (!isLocal) return;
      const resolvedOperationId = operationId ?? `${connection.id}-copy-${Date.now()}`;
      const runCopy = async () => {
        markOperationRunning(resolvedOperationId);
        try {
          await invokeCopyLocalPaths({
            sourcePaths,
            destinationDirectory,
            conflictPolicies: policies,
            operationId: resolvedOperationId,
          });
          removeOperation(resolvedOperationId);
        } catch (err) {
          markOperationFailed(
            resolvedOperationId,
            getLocalizedErrorMessage(err),
          );
          throw err;
        }
      };
      addOperation({
        operationId: resolvedOperationId,
        kind: 'upload',
        ownerId: connection.id,
        currentPath: sourcePaths[0],
        totalBytes: 0,
        processedBytes: 0,
        totalSteps: sourcePaths.length,
        completedSteps: 0,
        status: 'running',
        retry: runCopy,
      });
      try {
        await runCopy();
      } catch (err) {
        logger.warn('Copy with conflict policies failed', err);
        error(getToastErrorMessage(err));
      }
    },
    [addOperation, connection.id, error, isLocal, markOperationFailed, markOperationRunning, removeOperation],
  );

  const onEditPermissions = useCallback(
    (entry?: FileEntry) => {
      if (isLocal) return;
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      setPermissionsTarget(target as RemoteFileEntry);
    },
    [isLocal, selectedEntries],
  );

  const handlePermissions = useCallback(
    async (permissions: number) => {
      if (isLocal || !permissionsTarget) return;
      try {
        await updateRemotePermissions(permissionsTarget.path, permissions);
        clearSelection();
      } catch (err) {
        logger.warn(`Failed to update permissions: ${permissionsTarget.path}`, err);
        error(getToastErrorMessage(err));
      } finally {
        setPermissionsTarget(undefined);
      }
    },
    [clearSelection, isLocal, permissionsTarget, updateRemotePermissions, error],
  );

  const onProperties = useCallback(
    (entry?: FileEntry) => {
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      setPropertiesTarget(target);
    },
    [selectedEntries],
  );

  const onToggleBookmark = useCallback(
    (bookmarkPath?: string) => {
      if (isLocal) return;
      const targetPath = bookmarkPath ?? path;
      if (!targetPath) return;
      if (remoteBookmarks.includes(targetPath)) {
        removeRemoteBookmark(connection.id, side, targetPath);
      } else {
        addRemoteBookmark(connection.id, side, targetPath);
      }
    },
    [addRemoteBookmark, connection.id, isLocal, path, remoteBookmarks, removeRemoteBookmark, side],
  );

  const onRefresh = useCallback(async () => {
    try {
      await reload();
    } catch (err) {
      logger.warn('Failed to refresh directory', err);
      error(getToastErrorMessage(err));
    }
  }, [reload, error]);

  const onToggleBatchMode = useCallback(() => {
    const nextBatchMode = !pane.batchMode;
    setPaneState(connection.id, side, {
      batchMode: nextBatchMode,
      selectedPaths: nextBatchMode ? pane.selectedPaths : [],
    });
  }, [connection.id, pane.batchMode, pane.selectedPaths, setPaneState, side]);

  return {
    createMode,
    renameTarget,
    permissionsTarget,
    propertiesTarget,
    previewTarget,
    previewContent,
    hasLocalClipboard: localClipboard.length > 0,
    onOpen,
    onOpenWithDefaultEditor,
    onPreview,
    onDownload,
    onBatchDownload,
    uploadWithPolicies,
    copyWithPolicies,
    onCopy,
    onPaste,
    onRename,
    onDelete,
    onCopyName,
    onCopyPath,
    onCopyContainingDirectory,
    onNewFile,
    onNewFolder,
    onUploadFiles,
    onUploadFolders,
    onEditPermissions,
    onProperties,
    onToggleBookmark,
    onRefresh,
    onToggleBatchMode,
    setCreateMode,
    setRenameTarget,
    setPermissionsTarget,
    setPropertiesTarget,
    closePreview,
    handleCreate,
    handleRename,
    handlePermissions,
    // Exposed for blank menu use
    onCopyCurrentDirectoryPath,
  };
}
