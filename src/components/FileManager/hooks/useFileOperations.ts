import { useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { t } from '../../../lib/i18n';
import { createLogger } from '../../../lib/logger';
import { useFileManagerStore } from '../../../stores/fileManagerStore';
import { useOperationStore } from '../../../stores/operationStore';
import type {
  RemoteDirectoryListing,
  RemoteFileContent,
  RemoteFileEntry,
  RemoteFileKind,
} from '../../../types';
import {
  createOperationId,
  formatDirectoryLoadError,
  formatSize,
  localPathName,
} from '../lib/formatters';
import type {
  ClipboardState,
  EntryDialogState,
  OperationLogType,
  PendingDeleteState,
  PendingUploadConflictState,
  PermissionEditState,
  PropertiesState,
  UploadConflictAction,
  UploadConflictItem,
  UploadConflictPolicy,
} from '../types';

const fileManagerLogger = createLogger('file-manager');

export interface FileOperationConnection {
  host: string;
  port: number;
  username: string;
  authMethod: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

export interface ToastState {
  action?: { label: string; onClick: () => void };
  message: string;
  tone: 'success' | 'error' | 'info';
}

export interface UseFileOperationsOptions {
  sessionId?: string;
  connection?: FileOperationConnection;
  currentPath?: string;
  listing?: RemoteDirectoryListing;
  selectedEntry?: RemoteFileEntry;
  selectedEntries: RemoteFileEntry[];
  ready: boolean;
  readOnly: boolean;
  setWorking: (value: boolean) => void;
  setFileError: (value?: string) => void;
  setToast: (toast?: ToastState) => void;
  setDialog: (dialog?: EntryDialogState) => void;
  setProperties: (properties?: PropertiesState) => void;
  setPermissionEdit: (value?: PermissionEditState) => void;
  setPreview: (preview: RemoteFileContent | null) => void;
  clipboard?: ClipboardState;
  setClipboard: (clipboard?: ClipboardState) => void;
  setPendingUploadConflict: (state?: PendingUploadConflictState) => void;
  setPendingDelete: (state?: PendingDeleteState) => void;
  setPendingBatchDelete: (entries?: RemoteFileEntry[]) => void;
  setSelectedPath: (path?: string) => void;
  setSelectedPaths: (paths: string[]) => void;
  closeContextMenu: () => void;
}

function operationProgressPercent(event: {
  totalBytes: number;
  completedBytes: number;
  totalSteps: number;
  completedSteps: number;
}): number {
  if (event.totalBytes > 0) {
    return Math.min(100, Math.round((event.completedBytes / event.totalBytes) * 100));
  }
  if (event.totalSteps > 0) {
    return Math.min(100, Math.round((event.completedSteps / event.totalSteps) * 100));
  }
  return 0;
}

function formatOperationTotalText(event: {
  totalBytes: number;
  completedBytes: number;
  totalSteps: number;
  completedSteps: number;
}): string {
  if (event.totalBytes > 0) {
    return `${formatSize(event.completedBytes)} / ${formatSize(event.totalBytes)}`;
  }
  return t('fileManager.progress.items', { completed: event.completedSteps, total: event.totalSteps });
}

export function useFileOperations(options: UseFileOperationsOptions) {
  const {
    sessionId,
    connection,
    currentPath,
    listing,
    selectedEntry,
    selectedEntries,
    ready,
    readOnly,
    setWorking,
    setFileError,
    setToast,
  setDialog,
  setProperties,
  setPermissionEdit,
  setPreview,
  clipboard,
  setClipboard,
  setPendingUploadConflict,
    setPendingDelete,
    setPendingBatchDelete,
    setSelectedPath,
    setSelectedPaths,
    closeContextMenu,
  } = options;

  const uploadSessionByOperationRef = useRef<Record<string, string>>({});
  const uploadConflictResolverRef = useRef<((action: UploadConflictAction, applyToRemaining: boolean) => void) | null>(null);

  const updateSessionState = useFileManagerStore((state) => state.updateSessionState);
  const appendOperationLog = useFileManagerStore((state) => state.appendOperationLog);
  const updateOperationLog = useFileManagerStore((state) => state.updateOperationLog);
  const { startOperation, updateOperation, setOperationStatus } = useOperationStore();

  const addLog = useCallback(
    (type: OperationLogType, status: 'running', message: string, operationId?: string) => {
      if (!sessionId) return '';
      const id = createOperationId();
      appendOperationLog(sessionId, {
        id,
        type,
        status,
        message,
        timestamp: Date.now(),
        operationId,
      });
      return id;
    },
    [sessionId, appendOperationLog],
  );

  const updateLog = useCallback(
    (id: string, patch: { status?: 'completed' | 'failed' | 'cancelled'; message?: string }) => {
      if (!sessionId) return;
      updateOperationLog(sessionId, id, patch);
    },
    [sessionId, updateOperationLog],
  );

  const runFileAction = useCallback(
    async (task: () => Promise<unknown>, successMessage?: string) => {
      setWorking(true);
      setFileError(undefined);
      setToast(undefined);
      closeContextMenu();

      try {
        await task();
        setDialog(undefined);
        setProperties(undefined);
        if (successMessage) {
          setToast({ message: successMessage, tone: 'success' });
        }
      } catch (nextError) {
        fileManagerLogger.error('文件操作失败', String(nextError));
        setToast({ message: String(nextError), tone: 'error' });
      } finally {
        setWorking(false);
      }
    },
    [setWorking, setFileError, setToast, closeContextMenu, setDialog, setProperties],
  );

  const loadDirectory = useCallback(
    async (targetPath?: string) => {
      if (!ready || !connection || !sessionId) return;
      const requestedPath = targetPath ?? currentPath;

      setWorking(true);
      setFileError(undefined);
      closeContextMenu();
      fileManagerLogger.debug('开始加载目录', { sessionId, requestedPath });

      try {
        const nextListing = await invoke<RemoteDirectoryListing>('list_remote_directory', {
          request: { ...connection, path: targetPath },
        });
        updateSessionState(sessionId, (current) => ({
          error: undefined,
          listing: nextListing,
          pathInput: nextListing.path,
          selectedPath:
            current.selectedPath && nextListing.entries.some((entry) => entry.path === current.selectedPath)
              ? current.selectedPath
              : undefined,
        }));
        fileManagerLogger.debug('目录加载完成', {
          sessionId,
          path: nextListing.path,
          entryCount: nextListing.entries.length,
        });
      } catch (nextError) {
        fileManagerLogger.error('目录加载失败', {
          sessionId,
          requestedPath,
          error: String(nextError),
        });
        setFileError(formatDirectoryLoadError(nextError, requestedPath));
      } finally {
        setWorking(false);
      }
    },
    [ready, connection, sessionId, currentPath, setWorking, setFileError, closeContextMenu, updateSessionState],
  );

  const submitDialog = useCallback(
    async (dialog: EntryDialogState, targetEntry?: RemoteFileEntry) => {
      if (!ready || !dialog || !connection || !currentPath) return;

      if (dialog.mode === 'rename') {
        const renameTarget = targetEntry ?? selectedEntry;
        if (!renameTarget) return;

        await runFileAction(
          () =>
            invoke('rename_remote_path', {
              request: { ...connection, path: renameTarget.path, newName: dialog.value },
            }),
          t('fileManager.feedback.renameSuccess'),
        );
        await loadDirectory(currentPath);
        return;
      }

      await runFileAction(
        () =>
          invoke('create_remote_entry', {
            request: {
              ...connection,
              parentPath: currentPath,
              name: dialog.value,
              kind: dialog.mode === 'newFile' ? 'file' : 'directory',
            },
          }),
        dialog.mode === 'newFile' ? t('fileManager.feedback.fileCreated') : t('fileManager.feedback.directoryCreated'),
      );
      await loadDirectory(currentPath);
    },
    [ready, connection, currentPath, selectedEntry, runFileAction, loadDirectory],
  );

  const promptUploadConflict = useCallback(
    (conflict: UploadConflictItem, remainingConflicts: number) =>
      new Promise<{ action: UploadConflictAction; applyToRemaining: boolean }>((resolve) => {
        uploadConflictResolverRef.current = (action, applyToRemaining) => {
          uploadConflictResolverRef.current = null;
          resolve({ action, applyToRemaining });
        };
        setPendingUploadConflict({ conflict, remainingConflicts, applyToRemaining: false });
      }),
    [setPendingUploadConflict],
  );

  const resolveUploadSelection = useCallback(
    async (paths: string[]) => {
      const existingEntriesByName = new Map((listing?.entries ?? []).map((entry) => [entry.name, entry]));
      const acceptedPaths: string[] = [];
      const conflictPolicies: UploadConflictPolicy[] = [];
      let rememberedAction: Exclude<UploadConflictAction, 'cancel'> | undefined;
      let skippedConflicts = 0;
      let remainingConflicts = paths.reduce(
        (count, path) => count + (existingEntriesByName.has(localPathName(path)) ? 1 : 0),
        0,
      );

      for (const path of paths) {
        const targetName = localPathName(path);
        const existingEntry = existingEntriesByName.get(targetName);
        if (!existingEntry) {
          acceptedPaths.push(path);
          conflictPolicies.push('fail');
          continue;
        }

        remainingConflicts -= 1;
        let action = rememberedAction;
        if (!action) {
          const decision = await promptUploadConflict(
            { localPath: path, targetName, existingKind: existingEntry.kind },
            remainingConflicts,
          );

          if (decision.action === 'cancel') {
            return undefined;
          }

          action = decision.action;
          if (decision.applyToRemaining) {
            rememberedAction = action;
          }
        }

        if (action === 'skip') {
          skippedConflicts += 1;
          continue;
        }

        acceptedPaths.push(path);
        conflictPolicies.push('overwrite');
      }

      return { acceptedPaths, conflictPolicies, skippedConflicts };
    },
    [listing, promptUploadConflict],
  );

  const handleUploadPaths = useCallback(
    async (paths: string[]) => {
      if (!connection || !currentPath || !sessionId) return;

      const nextPaths = [...new Set(paths)].filter(Boolean);
      if (!nextPaths.length) return;

      const resolvedUpload = await resolveUploadSelection(nextPaths);
      if (!resolvedUpload) {
        setPendingUploadConflict(undefined);
        return;
      }

      setPendingUploadConflict(undefined);
      if (!resolvedUpload.acceptedPaths.length) {
        setToast({
          message:
            resolvedUpload.skippedConflicts > 0
              ? t('fileManager.feedback.uploadSkipped', { count: resolvedUpload.skippedConflicts })
              : t('fileManager.feedback.uploadNothing'),
          tone: 'info',
        });
        return;
      }

      const operationId = createOperationId();
      const firstName = localPathName(resolvedUpload.acceptedPaths[0]);
      const operationTitle =
        resolvedUpload.acceptedPaths.length === 1
          ? t('operationStatus.title.uploadSingle', { name: firstName })
          : t('operationStatus.title.uploadMulti', { count: resolvedUpload.acceptedPaths.length });
      startOperation({
        id: operationId,
        type: 'upload',
        title: operationTitle,
        progress: 0,
        totalText: t('fileManager.progress.items', { completed: 0, total: resolvedUpload.acceptedPaths.length }),
        canCancel: true,
      });

      const logId = addLog('upload', 'running', operationTitle, operationId);
      uploadSessionByOperationRef.current[operationId] = sessionId;
      setWorking(true);
      setFileError(undefined);
      setToast(undefined);
      closeContextMenu();

      try {
        await invoke('upload_local_paths', {
          request: {
            ...connection,
            destinationDirectory: currentPath,
            localPaths: resolvedUpload.acceptedPaths,
            conflictPolicies: resolvedUpload.conflictPolicies,
            operationId,
          },
        });
        await loadDirectory(currentPath);
        setOperationStatus(operationId, 'completed');
        const skippedSuffix = resolvedUpload.skippedConflicts
          ? t('fileManager.feedback.uploadSkippedSuffix', { count: resolvedUpload.skippedConflicts })
          : '';
        setToast({
          message:
            resolvedUpload.acceptedPaths.length === 1
              ? t('fileManager.feedback.uploadSingle', { name: firstName, suffix: skippedSuffix })
              : t('fileManager.feedback.uploadMulti', { count: resolvedUpload.acceptedPaths.length, suffix: skippedSuffix }),
          tone: 'success',
        });
        updateLog(logId, { status: 'completed' });
      } catch (nextError) {
        const message = String(nextError);
        const cancelled = message.includes('upload cancelled');
        if (cancelled) {
          await loadDirectory(currentPath);
          setOperationStatus(operationId, 'cancelled');
          updateLog(logId, { status: 'cancelled' });
        } else {
          setOperationStatus(operationId, 'failed', message);
          updateLog(logId, { status: 'failed', message });
        }
        setToast({
          message: cancelled ? t('fileManager.feedback.uploadCancelled') : message,
          tone: cancelled ? 'info' : 'error',
        });
      } finally {
        delete uploadSessionByOperationRef.current[operationId];
        setWorking(false);
      }
    },
    [
      connection,
      currentPath,
      sessionId,
      resolveUploadSelection,
      setPendingUploadConflict,
      setToast,
      startOperation,
      addLog,
      setWorking,
      setFileError,
      closeContextMenu,
      loadDirectory,
      setOperationStatus,
      updateLog,
    ],
  );

  const handleDownload = useCallback(
    async (entry?: RemoteFileEntry, entries?: RemoteFileEntry[]) => {
      if (!ready || !connection || !sessionId) return;

      const targets = entries?.length ? entries : entry ? [entry] : selectedEntry ? [selectedEntry] : [];
      if (!targets.length) return;

      let destinationDirectory: string;
      try {
        const selected = await invoke<string[]>('pick_local_folder', {
          title: t('fileManager.dialog.downloadDestination'),
        });
        if (!selected.length) return;
        destinationDirectory = selected[0];
      } catch (nextError) {
        setToast({ message: String(nextError), tone: 'error' });
        return;
      }

      const operationId = createOperationId();
      const operationTitle =
        targets.length === 1
          ? t('operationStatus.title.downloadSingle', { name: targets[0].name })
          : t('operationStatus.title.downloadMulti', { count: targets.length });
      startOperation({
        id: operationId,
        type: 'download',
        title: operationTitle,
        progress: 0,
        totalText: t('fileManager.progress.items', { completed: 0, total: targets.length }),
        canCancel: true,
      });

      const logId = addLog('download', 'running', operationTitle, operationId);
      setWorking(true);
      setFileError(undefined);
      setToast(undefined);
      closeContextMenu();

      try {
        await invoke('download_remote_paths', {
          request: {
            ...connection,
            remotePaths: targets.map((e) => e.path),
            destinationDirectory,
            operationId,
          },
        });
        setOperationStatus(operationId, 'completed');
        setToast({
          message:
            targets.length === 1
              ? t('fileManager.feedback.downloadSingle', { name: targets[0].name, path: destinationDirectory })
              : t('fileManager.feedback.downloadMulti', { count: targets.length, path: destinationDirectory }),
          tone: 'success',
          action: {
            label: t('fileManager.actions.openFolder'),
            onClick: () => void invoke('open_path', { path: destinationDirectory }),
          },
        });
        updateLog(logId, { status: 'completed' });
      } catch (nextError) {
        const message = String(nextError);
        const cancelled = message.includes('download cancelled');
        if (cancelled) {
          setOperationStatus(operationId, 'cancelled');
          updateLog(logId, { status: 'cancelled' });
        } else {
          setOperationStatus(operationId, 'failed', message);
          updateLog(logId, { status: 'failed', message });
        }
        setToast({
          message: cancelled ? t('fileManager.feedback.downloadCancelled') : message,
          tone: cancelled ? 'info' : 'error',
        });
      } finally {
        setWorking(false);
      }
    },
    [ready, connection, sessionId, selectedEntry, setToast, startOperation, addLog, setWorking, setFileError, closeContextMenu, setOperationStatus, updateLog],
  );

  const confirmDelete = useCallback(
    async (pendingDelete: PendingDeleteState) => {
      if (!ready || !connection || !sessionId) return;

      const target = pendingDelete;
      const operationId = createOperationId();
      startOperation({
        id: operationId,
        type: 'delete',
        title: t('operationStatus.title.deleteSingle', { name: target.name }),
        progress: 0,
        totalText: t('fileManager.progress.items', { completed: 0, total: 1 }),
        canCancel: true,
      });

      const logId = addLog('delete', 'running', t('operationStatus.title.deleteSingle', { name: target.name }), operationId);
      setWorking(true);
      setFileError(undefined);
      setToast(undefined);
      closeContextMenu();
      setPendingDelete(undefined);

      try {
        await invoke('delete_remote_path', {
          request: { ...connection, path: target.path, operationId },
        });
        setDialog(undefined);
        setProperties(undefined);
        setSelectedPath(undefined);
        await loadDirectory(currentPath);
        setOperationStatus(operationId, 'completed');
        setToast({ message: t('fileManager.feedback.deleteSuccess'), tone: 'success' });
        updateLog(logId, { status: 'completed' });
      } catch (nextError) {
        const message = String(nextError);
        const cancelled = message.includes('delete cancelled');
        if (cancelled) {
          await loadDirectory(currentPath);
          setOperationStatus(operationId, 'cancelled');
          updateLog(logId, { status: 'cancelled' });
        } else {
          setOperationStatus(operationId, 'failed', message);
          updateLog(logId, { status: 'failed', message });
        }
        setToast({
          message: cancelled ? t('fileManager.feedback.deleteCancelled') : message,
          tone: cancelled ? 'info' : 'error',
        });
      } finally {
        setWorking(false);
      }
    },
    [
      ready,
      connection,
      sessionId,
      currentPath,
      setWorking,
      setFileError,
      setToast,
      closeContextMenu,
      setPendingDelete,
      setDialog,
      setProperties,
      setSelectedPath,
      loadDirectory,
      setOperationStatus,
      addLog,
      updateLog,
    ],
  );

  const confirmBatchDelete = useCallback(
    async (pendingBatchDelete: RemoteFileEntry[]) => {
      if (!ready || !pendingBatchDelete?.length || !connection || !sessionId) return;

      setWorking(true);
      setFileError(undefined);
      setToast(undefined);
      closeContextMenu();
      setPendingBatchDelete(undefined);

      let successCount = 0;
      let failCount = 0;

      for (const target of pendingBatchDelete) {
        try {
          await invoke('delete_remote_path', {
            request: { ...connection, path: target.path, operationId: createOperationId() },
          });
          successCount += 1;
        } catch {
          failCount += 1;
        }
      }

      setSelectedPaths([]);
      setSelectedPath(undefined);
      await loadDirectory(currentPath);

      if (failCount === 0) {
        setToast({ message: t('fileManager.feedback.deleteSuccess'), tone: 'success' });
      } else {
        setToast({ message: `${successCount} deleted, ${failCount} failed`, tone: 'error' });
      }
      setWorking(false);
    },
    [ready, connection, sessionId, currentPath, setWorking, setFileError, setToast, closeContextMenu, setPendingBatchDelete, setSelectedPaths, setSelectedPath, loadDirectory],
  );

  const handleCopy = useCallback(
    (entry?: RemoteFileEntry) => {
      const target = entry;
      if (!target) return;

      setSelectedPath(target.path);
      setClipboard({ sourcePath: target.path, sourceName: target.name, kind: target.kind });
      setToast({
        message: t('fileManager.feedback.copiedEntry', { name: target.name }),
        tone: 'success',
        action: {
          label: t('fileManager.feedback.clear'),
          onClick: () => {
            setClipboard(undefined);
            setToast(undefined);
          },
        },
      });
      setFileError(undefined);
      closeContextMenu();
    },
    [setSelectedPath, setClipboard, setToast, setFileError, closeContextMenu],
  );

  const handleCopyText = useCallback(
    async (label: string, value: string) => {
      closeContextMenu();
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
        } else {
          const textarea = document.createElement('textarea');
          textarea.value = value;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          textarea.style.pointerEvents = 'none';
          document.body.append(textarea);
          textarea.select();
          document.execCommand('copy');
          textarea.remove();
        }
        setToast({
          message: t('fileManager.feedback.copiedLabel', { label }),
          tone: 'success',
        });
      } catch (nextError) {
        setToast({ message: String(nextError), tone: 'error' });
      }
    },
    [closeContextMenu, setToast],
  );

  const handlePaste = useCallback(async (source?: ClipboardState) => {
    const pasteSource = source ?? clipboard;
    if (!ready || !pasteSource || !connection || !currentPath) return;

    await runFileAction(
      () =>
        invoke('copy_remote_path', {
          request: {
            ...connection,
            sourcePath: pasteSource.sourcePath,
            destinationDirectory: currentPath,
          },
        }),
      t('fileManager.feedback.paste', { name: pasteSource.sourceName }),
    );
    await loadDirectory(currentPath);
  }, [ready, clipboard, connection, currentPath, runFileAction, loadDirectory]);

  const handleRename = useCallback(
    (entry?: RemoteFileEntry) => {
      if (!ready || !entry) return;
      setSelectedPath(entry.path);
      closeContextMenu();
      setDialog({ mode: 'rename', value: entry.name });
    },
    [ready, setSelectedPath, closeContextMenu, setDialog],
  );

  const handleDelete = useCallback(
    (entry?: RemoteFileEntry) => {
      if (!ready || !entry || !connection) return;
      setSelectedPath(entry.path);
      closeContextMenu();
      setPendingDelete({ path: entry.path, name: entry.name, kind: entry.kind });
    },
    [ready, connection, setSelectedPath, closeContextMenu, setPendingDelete],
  );

  const handleBatchDelete = useCallback(
    (selectedEntries: RemoteFileEntry[]) => {
      if (!ready || !selectedEntries.length) return;
      setPendingBatchDelete(selectedEntries);
      closeContextMenu();
    },
    [ready, setPendingBatchDelete, closeContextMenu],
  );

  const handlePreview = useCallback(
    async (entry?: RemoteFileEntry) => {
      const target = entry;
      if (!target || !connection || !sessionId || target.kind === 'directory') return;

      setSelectedPath(target.path);
      closeContextMenu();
      setWorking(true);
      setFileError(undefined);

      try {
        const result = await invoke<RemoteFileContent>('preview_remote_file', {
          connection,
          path: target.path,
        });
        setPreview(result);
      } catch (nextError) {
        setToast({ message: formatDirectoryLoadError(nextError, target.path), tone: 'error' });
      } finally {
        setWorking(false);
      }
    },
    [connection, sessionId, setSelectedPath, closeContextMenu, setWorking, setFileError, setPreview, setToast],
  );

  const handleOpenWithDefaultEditor = useCallback(
    async (entry?: RemoteFileEntry) => {
      if (!ready || !entry || !connection || entry.kind === 'directory') return;

      setSelectedPath(entry.path);
      closeContextMenu();
      setWorking(true);
      setToast(undefined);

      try {
        await invoke('open_remote_file', {
          request: { ...connection, path: entry.path },
        });
        setToast({ message: t('fileManager.feedback.openDefault', { name: entry.name }), tone: 'success' });
      } catch (nextError) {
        setToast({ message: String(nextError), tone: 'error' });
      } finally {
        setWorking(false);
      }
    },
    [ready, connection, setSelectedPath, closeContextMenu, setWorking, setToast],
  );

  const openProperties = useCallback(
    (entry?: RemoteFileEntry) => {
      if (!ready || !entry) return;
      setSelectedPath(entry.path);
      closeContextMenu();
      setProperties({
        entry,
        directoryPath: entry.kind === 'directory' ? entry.path : parentDirectoryPath(entry.path),
      });
      setPermissionEdit(undefined);
    },
    [ready, setSelectedPath, closeContextMenu, setProperties, setPermissionEdit],
  );

  const openPermissionEdit = useCallback(
    (entry?: RemoteFileEntry) => {
      if (!ready || !entry || entry.permissions === undefined) return;
      setSelectedPath(entry.path);
      closeContextMenu();
      setProperties({
        entry,
        directoryPath: entry.kind === 'directory' ? entry.path : parentDirectoryPath(entry.path),
      });
      setPermissionEdit({ entry, value: formatPermissionOctal(entry.permissions) });
    },
    [ready, setSelectedPath, closeContextMenu, setProperties, setPermissionEdit],
  );

  const submitPermissionEdit = useCallback(
    async (permissionEdit: PermissionEditState) => {
      if (!ready || !permissionEdit || !connection || !currentPath) return;

      const trimmed = permissionEdit.value.trim();
      const parsed = parseInt(trimmed, 8);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 0o7777) {
        setToast({ message: t('fileManager.error.invalidPermissions'), tone: 'error' });
        return;
      }

      await runFileAction(
        () =>
          invoke('update_remote_permissions', {
            request: { ...connection, path: permissionEdit.entry.path, permissions: parsed },
          }),
        t('fileManager.feedback.permissionsUpdated'),
      );
      await loadDirectory(currentPath);
      setPermissionEdit(undefined);
    },
    [ready, connection, currentPath, runFileAction, loadDirectory, setPermissionEdit, setToast],
  );

  const batchDownload = useCallback(
    (entries?: RemoteFileEntry[]) => {
      void handleDownload(undefined, entries?.length ? entries : selectedEntries);
    },
    [handleDownload, selectedEntries],
  );

  const batchDelete = useCallback(
    (entries?: RemoteFileEntry[]) => {
      handleBatchDelete(entries?.length ? entries : selectedEntries);
    },
    [handleBatchDelete, selectedEntries],
  );

  return {
    loadDirectory,
    submitDialog,
    uploadPaths: handleUploadPaths,
    downloadEntry: handleDownload,
    batchDownload,
    confirmDelete,
    batchDelete,
    confirmBatchDelete,
    copyEntry: handleCopy,
    handleCopyText,
    paste: handlePaste,
    openRenameDialog: handleRename,
    deleteEntry: handleDelete,
    previewFile: handlePreview,
    openWithDefaultEditor: handleOpenWithDefaultEditor,
    openProperties,
    openPermissionEdit,
    updatePermissions: submitPermissionEdit,
    resolveUploadSelection,
    uploadConflictResolverRef,
    uploadSessionByOperationRef,
  };
}

function formatPermissionOctal(permissions?: number): string {
  if (permissions === undefined) return '--';
  return `0${(permissions & 0o7777).toString(8).padStart(4, '0')}`;
}

function parentDirectoryPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length) return normalized.startsWith('/') ? '/' : '.';
  parts.pop();
  if (!parts.length) return normalized.startsWith('/') ? '/' : '.';
  return `${normalized.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}
