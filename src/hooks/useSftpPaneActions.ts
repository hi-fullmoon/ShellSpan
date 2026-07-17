import { useCallback, useMemo, useState } from 'react';
import {
  invokeCopyLocalPaths,
  invokePickLocalFiles,
  invokePickLocalFolder,
} from '@/lib/tauri';
import { useLocalDirectory } from '@/hooks/useLocalDirectory';
import { parentPortablePath } from '@/lib/path-utils';
import { useSftpConnection } from '@/hooks/useSftpConnection';
import { useToast } from '@/hooks/useToast';
import { useSftpStore, type SftpConnection, type SftpSide } from '@/stores/sftpStore';
import { useTransferStore } from '@/stores/transferStore';
import type { FileEntry } from '@/components/sftp/file-entry-formatters';
import type { ReadRemoteFileResponse, RemoteFileEntry, RemoteFileKind, UploadConflictPolicy } from '@/types';

export type UploadConflictAction = 'overwrite' | 'replace' | 'skip' | 'cancel';

export interface PendingUploadConflict {
  localPath: string;
  targetName: string;
  existingKind: RemoteFileKind;
  remainingConflicts: number;
}

export interface UseSftpPaneActionsResult {
  createMode: 'file' | 'folder' | null;
  renameTarget?: FileEntry;
  permissionsTarget?: RemoteFileEntry;
  propertiesTarget?: FileEntry;
  previewContent?: ReadRemoteFileResponse;
  uploadConflict?: PendingUploadConflict;
  onOpen: (entry: FileEntry) => void;
  onOpenWithDefaultEditor: (entry?: FileEntry) => Promise<void>;
  onPreview: (entry?: FileEntry) => Promise<void>;
  onDownload: (entry?: FileEntry) => Promise<void>;
  onBatchDownload: () => Promise<void>;
  uploadWithPolicies: (localPaths: string[], destinationDirectory: string, policies: UploadConflictPolicy[]) => Promise<void>;
  copyWithPolicies: (sourcePaths: string[], destinationDirectory: string, policies: UploadConflictPolicy[]) => Promise<void>;
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
  setPreviewContent: (content?: ReadRemoteFileResponse) => void;
  setUploadConflict: (conflict?: PendingUploadConflict) => void;
  handleCreate: (name: string, kind: 'file' | 'directory') => Promise<void>;
  handleRename: (newName: string) => Promise<void>;
  handlePermissions: (permissions: number) => Promise<void>;
}

export function parentDirectoryPath(path: string): string {
  return parentPortablePath(path);
}

function writeClipboardText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value);
  }
  return new Promise((resolve) => {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    resolve();
  });
}

export function useSftpPaneActions(
  connection: SftpConnection,
  side: SftpSide,
): UseSftpPaneActionsResult {
  const isLocal = side === 'local';
  const path = isLocal ? connection.localPath : connection.remotePath;
  const entries = isLocal ? connection.localEntries : connection.remoteEntries;
  const pane = isLocal ? connection.localPane : connection.remotePane;
  const remoteBookmarks = connection.remoteBookmarks;

  const { loadLocalDirectory } = useLocalDirectory(connection);
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
  } = useSftpConnection(connection);
  const { addOperation, markOperationFailed, markOperationRunning, removeOperation } = useTransferStore();
  const { error, success } = useToast();

  const setPaneState = useSftpStore((state) => state.setPaneState);
  const setRemoteClipboard = useSftpStore((state) => state.setRemoteClipboard);
  const addRemoteBookmark = useSftpStore((state) => state.addRemoteBookmark);
  const removeRemoteBookmark = useSftpStore((state) => state.removeRemoteBookmark);

  const [createMode, setCreateMode] = useState<'file' | 'folder' | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileEntry | undefined>(undefined);
  const [permissionsTarget, setPermissionsTarget] = useState<RemoteFileEntry | undefined>(undefined);
  const [propertiesTarget, setPropertiesTarget] = useState<FileEntry | undefined>(undefined);
  const [previewContent, setPreviewContent] = useState<ReadRemoteFileResponse | undefined>(undefined);
  const [uploadConflict, setUploadConflict] = useState<PendingUploadConflict | undefined>(undefined);

  const selectedPaths = pane.selectedPaths;
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedPaths.includes(entry.path)),
    [entries, selectedPaths],
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
    async (entry?: FileEntry) => {
      if (isLocal) return;
      const target = entry ?? selectedEntries[0];
      if (!target || target.kind === 'directory') return;
      try {
        await openRemoteFile(target.path);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    },
    [isLocal, openRemoteFile, selectedEntries, error],
  );

  const onPreview = useCallback(
    async (entry?: FileEntry) => {
      if (isLocal) return;
      const target = entry ?? selectedEntries[0];
      if (!target || target.kind === 'directory') return;
      try {
        const content = await previewRemoteFile(target.path);
        setPreviewContent(content);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    },
    [isLocal, previewRemoteFile, selectedEntries, error],
  );

  const onDownload = useCallback(
    async (entry?: FileEntry) => {
      if (isLocal) return;
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      try {
        const folders = await invokePickLocalFolder();
        if (!folders.length) return;
        const operationId = `${connection.id}-download-${Date.now()}`;
        addOperation({
          operationId,
          kind: 'download',
          currentPath: target.path,
          totalBytes: 0,
          processedBytes: 0,
          totalSteps: 1,
          completedSteps: 0,
        });
        await downloadRemotePaths([target.path], folders[0], operationId);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    },
    [addOperation, connection.id, downloadRemotePaths, isLocal, selectedEntries, error],
  );

  const onBatchDownload = useCallback(
    async () => {
      if (isLocal || !selectedEntries.length) return;
      try {
        const folders = await invokePickLocalFolder();
        if (!folders.length) return;
        const operationId = `${connection.id}-batch-download-${Date.now()}`;
        addOperation({
          operationId,
          kind: 'download',
          currentPath: selectedEntries[0]?.path,
          totalBytes: 0,
          processedBytes: 0,
          totalSteps: selectedEntries.length,
          completedSteps: 0,
        });
        await downloadRemotePaths(
          selectedEntries.map((e) => e.path),
          folders[0],
          operationId,
        );
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    },
    [addOperation, connection.id, downloadRemotePaths, isLocal, selectedEntries, error],
  );

  const onCopy = useCallback(
    (entry?: FileEntry) => {
      if (isLocal) return;
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      setRemoteClipboard(connection.id, {
        sourcePath: target.path,
        sourceName: target.name,
        kind: target.kind,
      });
      success(`Copied ${target.name}`);
    },
    [connection.id, isLocal, selectedEntries, setRemoteClipboard, success],
  );

  const onPaste = useCallback(async () => {
    if (isLocal || !connection.remoteClipboard) return;
    try {
      await copyRemotePath(connection.remoteClipboard.sourcePath, path);
      await reload();
      clearSelection();
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
    }
  }, [clearSelection, connection.remoteClipboard, copyRemotePath, isLocal, path, reload, error]);

  const onCopyName = useCallback(
    async (entry?: FileEntry) => {
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      try {
        await writeClipboardText(target.name);
        success('Copied name');
      } catch {
        error('Failed to copy name');
      }
    },
    [selectedEntries, error, success],
  );

  const onCopyPath = useCallback(
    async (entry?: FileEntry) => {
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      try {
        await writeClipboardText(target.path);
        success('Copied path');
      } catch {
        error('Failed to copy path');
      }
    },
    [selectedEntries, error, success],
  );

  const onCopyContainingDirectory = useCallback(
    async (entry?: FileEntry) => {
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      const dir = target.kind === 'directory' ? target.path : parentDirectoryPath(target.path);
      try {
        await writeClipboardText(dir);
        success('Copied directory path');
      } catch {
        error('Failed to copy directory path');
      }
    },
    [selectedEntries, error, success],
  );

  const onCopyCurrentDirectoryPath = useCallback(async () => {
    if (!path) return;
    try {
      await writeClipboardText(path);
      success('Copied current directory path');
    } catch {
      error('Failed to copy current directory path');
    }
  }, [path, error, success]);

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
        await reload();
        clearSelection();
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      } finally {
        setCreateMode(null);
      }
    },
    [clearSelection, createRemoteEntry, isLocal, path, reload, error],
  );

  const onRename = useCallback(
    (entry?: FileEntry) => {
      if (isLocal) return;
      const target = entry ?? selectedEntries[0];
      if (!target) return;
      setRenameTarget(target);
    },
    [isLocal, selectedEntries],
  );

  const handleRename = useCallback(
    async (newName: string) => {
      if (isLocal || !renameTarget) return;
      try {
        await renameRemotePath(renameTarget.path, newName);
        await reload();
        clearSelection();
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      } finally {
        setRenameTarget(undefined);
      }
    },
    [clearSelection, isLocal, renameRemotePath, renameTarget, reload, error],
  );

  const onDelete = useCallback(
    async (entriesToDelete?: FileEntry[]) => {
      if (isLocal) return;
      const targets = entriesToDelete?.length ? entriesToDelete : selectedEntries;
      if (!targets.length) return;
      try {
        await deleteRemotePaths(targets.map((e) => e.path));
        await reload();
        clearSelection();
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    },
    [clearSelection, deleteRemotePaths, isLocal, reload, selectedEntries, error],
  );

  const onUploadFiles = useCallback(async () => {
    if (isLocal) return;
    try {
      const files = await invokePickLocalFiles();
      if (!files.length) return;
      const operationId = `${connection.id}-upload-${Date.now()}`;
      addOperation({
        operationId,
        kind: 'upload',
        currentPath: files[0],
        totalBytes: 0,
        processedBytes: 0,
        totalSteps: files.length,
        completedSteps: 0,
      });
      await uploadLocalPaths(files, path, operationId);
      await reload();
      clearSelection();
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
    }
  }, [addOperation, connection.id, clearSelection, isLocal, path, reload, uploadLocalPaths, error]);

  const onUploadFolders = useCallback(async () => {
    if (isLocal) return;
    try {
      const folders = await invokePickLocalFolder();
      if (!folders.length) return;
      const operationId = `${connection.id}-upload-${Date.now()}`;
      addOperation({
        operationId,
        kind: 'upload',
        currentPath: folders[0],
        totalBytes: 0,
        processedBytes: 0,
        totalSteps: folders.length,
        completedSteps: 0,
      });
      await uploadLocalPaths(folders, path, operationId);
      await reload();
      clearSelection();
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
    }
  }, [addOperation, connection.id, clearSelection, isLocal, path, reload, uploadLocalPaths, error]);

  const uploadWithPolicies = useCallback(
    async (localPaths: string[], destinationDirectory: string, policies: UploadConflictPolicy[]) => {
      if (isLocal) return;
      try {
        const operationId = `${connection.id}-upload-${Date.now()}`;
        addOperation({
          operationId,
          kind: 'upload',
          currentPath: localPaths[0],
          totalBytes: 0,
          processedBytes: 0,
          totalSteps: localPaths.length,
          completedSteps: 0,
        });
        await uploadLocalPaths(localPaths, destinationDirectory, operationId, policies);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      }
    },
    [addOperation, connection.id, isLocal, uploadLocalPaths, error],
  );

  const copyWithPolicies = useCallback(
    async (sourcePaths: string[], destinationDirectory: string, policies: UploadConflictPolicy[]) => {
      if (!isLocal) return;
      const operationId = `${connection.id}-copy-${Date.now()}`;
      const runCopy = async () => {
        markOperationRunning(operationId);
        try {
          await invokeCopyLocalPaths({
            sourcePaths,
            destinationDirectory,
            conflictPolicies: policies,
            operationId,
          });
          removeOperation(operationId);
        } catch (err) {
          markOperationFailed(
            operationId,
            err instanceof Error ? err.message : String(err),
          );
          throw err;
        }
      };
      addOperation({
        operationId,
        kind: 'upload',
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
        error(err instanceof Error ? err.message : String(err));
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
        await reload();
        clearSelection();
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
      } finally {
        setPermissionsTarget(undefined);
      }
    },
    [clearSelection, isLocal, permissionsTarget, reload, updateRemotePermissions, error],
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
        removeRemoteBookmark(connection.id, targetPath);
      } else {
        addRemoteBookmark(connection.id, targetPath);
      }
    },
    [addRemoteBookmark, connection.id, isLocal, path, remoteBookmarks, removeRemoteBookmark],
  );

  const onRefresh = useCallback(async () => {
    try {
      await reload();
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
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
    previewContent,
    uploadConflict,
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
    setPreviewContent,
    setUploadConflict,
    handleCreate,
    handleRename,
    handlePermissions,
    // Exposed for blank menu use
    onCopyCurrentDirectoryPath,
  };
}
