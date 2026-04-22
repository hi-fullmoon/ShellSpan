import {
  AllCommunityModule,
  ModuleRegistry,
  type CellContextMenuEvent,
  type ColDef,
  type ICellRendererParams,
  type RowClickedEvent,
  type RowDoubleClickedEvent,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createPortal } from 'react-dom';
import { type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getActiveLocale, t } from '../lib/i18n';
import { createLogger } from '../lib/logger';
import { addPathWrapOpportunities } from '../lib/pathDisplay';
import { isTauriRuntime } from '../lib/tauri';
import { useFileManagerStore } from '../stores/fileManagerStore';
import { cn, fileKindColor } from '../lib/ui';
import { ArrowUpIcon, CloseIcon, DotsIcon, FileIcon, FolderIcon, LinkIcon, RefreshIcon } from './Icons';
import { ScrollArea } from './ScrollArea';
import { Toast, type ToastAction } from './Toast';
import type {
  DeleteProgressEvent,
  DownloadProgressEvent,
  DownloadProgressState,
  RemoteDirectoryListing,
  RemoteFileEntry,
  RemoteFileKind,
  SessionState,
  UploadProgressEvent,
  UploadProgressState,
} from '../types';

interface FileManagerProps {
  session?: SessionState;
  ignoreWindowDragDrop?: boolean;
}

type EntryDialogMode = 'newFile' | 'newDirectory' | 'rename';
type CreateEntryDialogMode = Exclude<EntryDialogMode, 'rename'>;
type MenuTarget = 'blank' | 'entry' | 'toolbar';

interface EntryDialogState {
  mode: EntryDialogMode;
  value: string;
}

interface ClipboardState {
  sourcePath: string;
  sourceName: string;
  kind: RemoteFileKind;
}

interface PendingDeleteState {
  path: string;
  name: string;
  kind: RemoteFileKind;
}

interface PropertiesState {
  entry: RemoteFileEntry;
  directoryPath: string;
}

interface ToastState {
  action?: ToastAction;
  message: string;
  tone: 'success' | 'error' | 'info';
}

interface DeleteProgressState {
  operationId: string;
  currentPath?: string;
  totalSteps: number;
  completedSteps: number;
  cancelling?: boolean;
}

type UploadConflictPolicy = 'overwrite' | 'skip' | 'fail';
type UploadConflictAction = 'overwrite' | 'skip' | 'cancel';

interface UploadConflictItem {
  localPath: string;
  targetName: string;
  existingKind: RemoteFileKind;
}

interface PendingUploadConflictState {
  conflict: UploadConflictItem;
  remainingConflicts: number;
  applyToRemaining: boolean;
}

interface WindowDragDropState {
  ready: boolean;
  currentPath?: string;
  ignoreWindowDragDrop?: boolean;
  loading: boolean;
  working: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
  target: MenuTarget;
  entry?: RemoteFileEntry;
}

ModuleRegistry.registerModules([AllCommunityModule]);
const fileManagerLogger = createLogger('file-manager');

function clampMenuPosition(x: number, y: number, width: number, height: number) {
  const edge = 8;
  return {
    x: Math.max(edge, Math.min(x, window.innerWidth - width - edge)),
    y: Math.max(edge, Math.min(y, window.innerHeight - height - edge)),
  };
}

function formatSize(size?: number) {
  if (size === undefined) {
    return '--';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function formatModified(modifiedAt?: number) {
  if (!modifiedAt) {
    return '--';
  }

  return new Intl.DateTimeFormat(getActiveLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(modifiedAt * 1000));
}

function formatFullModified(modifiedAt?: number) {
  if (!modifiedAt) {
    return '--';
  }

  return new Intl.DateTimeFormat(getActiveLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(modifiedAt * 1000));
}

function localPathName(path: string) {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() ?? path;
}

export function formatDirectoryLoadError(error: unknown, requestedPath?: string) {
  const message = String(error);
  const normalized = message.toLowerCase();

  if (normalized.includes('[sftp(2)]') && normalized.includes('no such file')) {
    if (requestedPath?.trim()) {
      return t('fileManager.error.pathMissingWithPath', {
        label: t('fileManager.property.path'),
        path: requestedPath.trim(),
      });
    }
    return t('fileManager.error.pathMissing', { label: t('fileManager.property.path') });
  }

  return t('fileManager.error.loadDirectory', { message });
}

function createOperationId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function uploadProgressPercent(progress?: UploadProgressState) {
  if (!progress) {
    return 0;
  }

  if (progress.totalBytes > 0) {
    return Math.min(100, Math.round((progress.uploadedBytes / progress.totalBytes) * 100));
  }

  if (progress.totalSteps > 0) {
    return Math.min(100, Math.round((progress.completedSteps / progress.totalSteps) * 100));
  }

  return 0;
}

function downloadProgressPercent(progress?: DownloadProgressState) {
  if (!progress) {
    return 0;
  }

  if (progress.totalBytes > 0) {
    return Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100));
  }

  if (progress.totalSteps > 0) {
    return Math.min(100, Math.round((progress.completedSteps / progress.totalSteps) * 100));
  }

  return 0;
}

function stepProgressPercent(progress?: { totalSteps: number; completedSteps: number }) {
  if (!progress || progress.totalSteps <= 0) {
    return 0;
  }

  return Math.min(100, Math.round((progress.completedSteps / progress.totalSteps) * 100));
}

function parentDirectoryPath(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);

  if (!parts.length) {
    return normalized.startsWith('/') ? '/' : '.';
  }

  parts.pop();
  if (!parts.length) {
    return normalized.startsWith('/') ? '/' : '.';
  }

  return `${normalized.startsWith('/') ? '/' : ''}${parts.join('/')}`;
}

function kindLabel(kind: RemoteFileKind) {
  switch (kind) {
    case 'directory':
      return t('fileManager.kind.directory');
    case 'file':
      return t('fileManager.kind.file');
    case 'symlink':
      return t('fileManager.kind.symlink');
    case 'other':
      return t('fileManager.kind.other');
  }
}

function permissionTypePrefix(kind: RemoteFileKind) {
  switch (kind) {
    case 'directory':
      return 'd';
    case 'symlink':
      return 'l';
    case 'file':
      return '-';
    case 'other':
      return '?';
  }
}

function canProcessWindowDragDrop(state: WindowDragDropState) {
  return state.ready && Boolean(state.currentPath) && !state.ignoreWindowDragDrop && !state.loading && !state.working;
}

function formatPermissionOctal(permissions?: number) {
  if (permissions === undefined) {
    return '--';
  }

  return `0${(permissions & 0o7777).toString(8).padStart(4, '0')}`;
}

function formatPermissionSymbolic(permissions: number | undefined, kind: RemoteFileKind) {
  if (permissions === undefined) {
    return '--';
  }

  const ownerExec = (permissions & 0o100) === 0o100;
  const groupExec = (permissions & 0o010) === 0o010;
  const otherExec = (permissions & 0o001) === 0o001;
  const symbolic = [
    (permissions & 0o400) === 0o400 ? 'r' : '-',
    (permissions & 0o200) === 0o200 ? 'w' : '-',
    (permissions & 0o4000) === 0o4000 ? (ownerExec ? 's' : 'S') : ownerExec ? 'x' : '-',
    (permissions & 0o040) === 0o040 ? 'r' : '-',
    (permissions & 0o020) === 0o020 ? 'w' : '-',
    (permissions & 0o2000) === 0o2000 ? (groupExec ? 's' : 'S') : groupExec ? 'x' : '-',
    (permissions & 0o004) === 0o004 ? 'r' : '-',
    (permissions & 0o002) === 0o002 ? 'w' : '-',
    (permissions & 0o1000) === 0o1000 ? (otherExec ? 't' : 'T') : otherExec ? 'x' : '-',
  ].join('');

  return `${permissionTypePrefix(kind)}${symbolic}`;
}

function formatOwnership(entry: RemoteFileEntry) {
  const owner = entry.ownerName?.trim() ? entry.ownerName : entry.ownerUid !== undefined ? `U${entry.ownerUid}` : '--';
  const group = entry.groupName?.trim() ? entry.groupName : entry.groupGid !== undefined ? `G${entry.groupGid}` : '--';
  return `${owner}:${group}`;
}

function formatOwner(entry: RemoteFileEntry) {
  return entry.ownerName?.trim() ? entry.ownerName : entry.ownerUid !== undefined ? `U${entry.ownerUid}` : '--';
}

function formatGroup(entry: RemoteFileEntry) {
  return entry.groupName?.trim() ? entry.groupName : entry.groupGid !== undefined ? `G${entry.groupGid}` : '--';
}

function NameCellRenderer({ data }: ICellRendererParams<RemoteFileEntry>) {
  if (!data) {
    return null;
  }

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <span className={cn('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md', fileKindColor(data.kind))}>
        {fileKindIcon(data.kind)}
      </span>
      <span className="file-entry-name truncate text-[13px] font-medium leading-5 tracking-[0.01em]">{data.name}</span>
    </div>
  );
}

async function writeClipboardText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

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

function fileKindIcon(kind: RemoteFileKind) {
  switch (kind) {
    case 'directory':
      return <FolderIcon />;
    case 'file':
      return <FileIcon />;
    case 'symlink':
      return <LinkIcon />;
    case 'other':
      return <DotsIcon />;
  }
}

function MenuButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      className="themed-menu-item rounded-md px-2 py-1 text-left text-[12px] font-medium transition disabled:cursor-not-allowed"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function MenuDivider() {
  return <div className="themed-menu-divider my-1 h-px" />;
}

function PropertyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="themed-property-row grid grid-cols-[72px_minmax(0,1fr)] gap-2 rounded-lg px-2 py-2">
      <span className="themed-property-row__label text-[11px] font-medium leading-5 tracking-[0.02em]">{label}</span>
      <span className="themed-property-row__value break-all text-[12px] leading-5">{value}</span>
    </div>
  );
}

function OverlayLayer({ children, tone = 'modal' }: { children: ReactNode; tone?: 'modal' | 'progress' }) {
  return (
    <div
      className={
        tone === 'progress'
          ? 'absolute inset-0 z-10 flex items-center justify-center p-2 backdrop-blur-sm'
          : 'absolute inset-0 z-20 grid place-items-center p-2 backdrop-blur-[14px]'
      }
      style={{ background: 'var(--app-overlay)' }}
    >
      {children}
    </div>
  );
}

function OverlayPanel({ children, className, ...props }: { children: ReactNode; className: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('surface flex w-full flex-col gap-2 p-3', className)} {...props}>
      {children}
    </div>
  );
}

export function FileManager({ session, ignoreWindowDragDrop = false }: FileManagerProps) {
  const gridRef = useRef<AgGridReact<RemoteFileEntry> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const uploadSessionByOperationRef = useRef<Record<string, string>>({});
  const latestWindowDropStateRef = useRef<WindowDragDropState>({
    ready: false,
    currentPath: undefined,
    ignoreWindowDragDrop: false,
    loading: false,
    working: false,
  });
  const uploadPathsRef = useRef<(paths: string[]) => Promise<void>>(async () => {});
  const uploadConflictResolverRef = useRef<((action: UploadConflictAction, applyToRemaining: boolean) => void) | null>(null);
  const hasLoadedAnyListingRef = useRef(false);
  const [clipboard, setClipboard] = useState<ClipboardState>();
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteState>();
  const [pendingUploadConflict, setPendingUploadConflict] = useState<PendingUploadConflictState>();
  const [properties, setProperties] = useState<PropertiesState>();
  const [dialog, setDialog] = useState<EntryDialogState>();
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<DeleteProgressState>();
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgressState>();
  const [toast, setToast] = useState<ToastState>();
  const sessionId = session?.sessionId;
  const fileManagerState = useFileManagerStore((state) => (sessionId ? state.sessions[sessionId] : undefined));
  const updateSessionState = useFileManagerStore((state) => state.updateSessionState);

  const connection = useMemo(() => {
    if (!session) {
      return undefined;
    }

    return {
      host: session.host,
      port: session.port,
      username: session.username,
      authMethod: session.profile.authMethod,
      password: session.profile.password || undefined,
      privateKeyPath: session.profile.privateKeyPath?.trim() || undefined,
      passphrase: session.profile.passphrase || undefined,
    };
  }, [session]);

  const listing = fileManagerState?.listing;
  const pathInput = fileManagerState?.pathInput ?? '';
  const selectedPath = fileManagerState?.selectedPath;
  const error = fileManagerState?.error;
  const uploadProgress = fileManagerState?.uploadProgress;
  const selectedEntry = useMemo(() => listing?.entries.find((entry) => entry.path === selectedPath), [listing, selectedPath]);
  const ready = !!session && session.status === 'connected' && !!connection;
  const readOnly = !!session && session.status !== 'connected';
  const currentPath = listing?.path;
  const showInitialLoadingHint = !hasLoadedAnyListingRef.current;
  const locale = getActiveLocale();
  const columnDefs = useMemo<ColDef<RemoteFileEntry>[]>(
    () => [
      {
        cellRenderer: NameCellRenderer,
        field: 'name',
        headerName: t('fileManager.columns.name'),
        width: 240,
        minWidth: 160,
        resizable: true,
        suppressMovable: true,
        tooltipField: 'name',
        flex: 1,
      },
      {
        field: 'modifiedAt',
        headerName: t('fileManager.columns.time'),
        width: 142,
        minWidth: 142,
        resizable: true,
        suppressMovable: true,
        valueFormatter: ({ data }) => (data ? formatModified(data.modifiedAt) : '--'),
        cellClass: 'tabular-nums',
      },
      {
        field: 'kind',
        headerName: t('fileManager.columns.type'),
        width: 88,
        minWidth: 88,
        resizable: true,
        suppressMovable: true,
        valueGetter: ({ data }) => (data ? kindLabel(data.kind) : '--'),
        valueFormatter: ({ data }) => (data ? kindLabel(data.kind) : '--'),
      },
      {
        field: 'size',
        headerName: t('fileManager.columns.size'),
        width: 84,
        minWidth: 84,
        resizable: true,
        suppressMovable: true,
        valueFormatter: ({ data }) => (data ? (data.kind === 'directory' ? '--' : formatSize(data.size)) : '--'),
      },
      {
        headerName: t('fileManager.columns.permissions'),
        width: 148,
        minWidth: 148,
        resizable: true,
        suppressMovable: true,
        valueGetter: ({ data }) => (data ? formatPermissionSymbolic(data.permissions, data.kind) : '--'),
        valueFormatter: ({ data }) => (data ? formatPermissionSymbolic(data.permissions, data.kind) : '--'),
        cellClass: 'font-mono',
      },
      {
        headerName: t('fileManager.columns.owner'),
        width: 88,
        minWidth: 88,
        resizable: true,
        suppressMovable: true,
        valueGetter: ({ data }) => (data ? formatOwner(data) : '--'),
        valueFormatter: ({ data }) => (data ? formatOwner(data) : '--'),
        cellClass: 'font-mono',
      },
      {
        headerName: t('fileManager.columns.group'),
        width: 88,
        minWidth: 88,
        resizable: true,
        suppressMovable: true,
        valueGetter: ({ data }) => (data ? formatGroup(data) : '--'),
        valueFormatter: ({ data }) => (data ? formatGroup(data) : '--'),
        cellClass: 'font-mono',
      },
    ],
    [locale],
  );
  const defaultColDef = useMemo<ColDef<RemoteFileEntry>>(
    () => ({
      sortable: true,
      menuTabs: [],
      unSortIcon: true,
    }),
    [],
  );

  const setPathInput = (value: string) => {
    if (!sessionId) {
      return;
    }

    updateSessionState(sessionId, { pathInput: value });
  };

  const setSelectedPath = (value?: string) => {
    if (!sessionId) {
      return;
    }

    updateSessionState(sessionId, { selectedPath: value });
  };

  const setFileError = (value?: string) => {
    if (!sessionId) {
      return;
    }

    updateSessionState(sessionId, { error: value });
  };

  const loadDirectory = async (targetPath?: string) => {
    if (!ready || !connection || !sessionId) {
      return;
    }
    const requestedPath = targetPath ?? currentPath;

    setLoading(true);
    setFileError(undefined);
    setContextMenu(undefined);
    fileManagerLogger.debug('开始加载目录', {
      sessionId,
      requestedPath,
    });

    try {
      const nextListing = await invoke<RemoteDirectoryListing>('list_remote_directory', {
        request: {
          ...connection,
          path: targetPath,
        },
      });
      updateSessionState(sessionId, (current) => ({
        error: undefined,
        listing: nextListing,
        pathInput: nextListing.path,
        selectedPath:
          current.selectedPath && nextListing.entries.some((entry) => entry.path === current.selectedPath) ? current.selectedPath : undefined,
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
      setLoading(false);
    }
  };

  const runFileAction = async (task: () => Promise<unknown>, successMessage?: string) => {
    setWorking(true);
    setFileError(undefined);
    setToast(undefined);
    setContextMenu(undefined);

    try {
      await task();
      setDialog(undefined);
      setProperties(undefined);
      await loadDirectory(currentPath);
      if (successMessage) {
        setToast({
          message: successMessage,
          tone: 'success',
        });
      }
    } catch (nextError) {
      fileManagerLogger.error('文件操作失败', String(nextError));
      setToast({
        message: String(nextError),
        tone: 'error',
      });
    } finally {
      setWorking(false);
    }
  };

  const promptUploadConflict = (conflict: UploadConflictItem, remainingConflicts: number) =>
    new Promise<{ action: UploadConflictAction; applyToRemaining: boolean }>((resolve) => {
      uploadConflictResolverRef.current = (action, applyToRemaining) => {
        uploadConflictResolverRef.current = null;
        resolve({ action, applyToRemaining });
      };
      setPendingUploadConflict({
        conflict,
        remainingConflicts,
        applyToRemaining: false,
      });
    });

  const resolveUploadSelection = async (paths: string[]) => {
    const existingEntriesByName = new Map((listing?.entries ?? []).map((entry) => [entry.name, entry]));
    const acceptedPaths: string[] = [];
    const conflictPolicies: UploadConflictPolicy[] = [];
    let rememberedAction: Exclude<UploadConflictAction, 'cancel'> | undefined;
    let skippedConflicts = 0;
    let remainingConflicts = paths.reduce((count, path) => count + (existingEntriesByName.has(localPathName(path)) ? 1 : 0), 0);

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
          {
            localPath: path,
            targetName,
            existingKind: existingEntry.kind,
          },
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

    return {
      acceptedPaths,
      conflictPolicies,
      skippedConflicts,
    };
  };

  const handleUploadPaths = async (paths: string[]) => {
    if (!connection || !currentPath || !sessionId) {
      return;
    }

    const nextPaths = [...new Set(paths)].filter(Boolean);
    if (!nextPaths.length) {
      return;
    }

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
    fileManagerLogger.info('开始上传', {
      sessionId,
      destinationDirectory: currentPath,
      itemCount: resolvedUpload.acceptedPaths.length,
    });
    setWorking(true);
    setFileError(undefined);
    setToast(undefined);
    setContextMenu(undefined);
    uploadSessionByOperationRef.current[operationId] = sessionId;
    updateSessionState(sessionId, {
      uploadProgress: {
        operationId,
        currentPath: resolvedUpload.acceptedPaths[0],
        totalBytes: 0,
        uploadedBytes: 0,
        totalSteps: resolvedUpload.acceptedPaths.length,
        completedSteps: 0,
        cancelling: false,
      },
    });

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
      const skippedSuffix = resolvedUpload.skippedConflicts
        ? t('fileManager.feedback.uploadSkippedSuffix', { count: resolvedUpload.skippedConflicts })
        : '';
      setToast({
        message:
          resolvedUpload.acceptedPaths.length === 1
            ? t('fileManager.feedback.uploadSingle', {
                name: localPathName(resolvedUpload.acceptedPaths[0]),
                suffix: skippedSuffix,
              })
            : t('fileManager.feedback.uploadMulti', {
                count: resolvedUpload.acceptedPaths.length,
                suffix: skippedSuffix,
              }),
        tone: 'success',
      });
      fileManagerLogger.info('上传完成', {
        sessionId,
        operationId,
        destinationDirectory: currentPath,
        itemCount: resolvedUpload.acceptedPaths.length,
      });
    } catch (nextError) {
      const message = String(nextError);
      const cancelled = message.includes('upload cancelled');
      if (cancelled) {
        await loadDirectory(currentPath);
      }
      if (cancelled) {
        fileManagerLogger.info('上传已取消', { sessionId, operationId });
      } else {
        fileManagerLogger.error('上传失败', { sessionId, operationId, error: message });
      }
      setToast({
        message: cancelled ? t('fileManager.feedback.uploadCancelled') : message,
        tone: cancelled ? 'info' : 'error',
      });
    } finally {
      delete uploadSessionByOperationRef.current[operationId];
      updateSessionState(sessionId, (current) => (current.uploadProgress?.operationId === operationId ? { uploadProgress: undefined } : {}));
      setWorking(false);
    }
  };

  latestWindowDropStateRef.current = {
    ready,
    currentPath,
    ignoreWindowDragDrop,
    loading,
    working,
  };
  uploadPathsRef.current = handleUploadPaths;

  const openCreateDialog = (mode: CreateEntryDialogMode) => {
    if (!ready) {
      return;
    }
    setDialog({ mode, value: '' });
    setContextMenu(undefined);
  };

  const handleSelectUploadFiles = async () => {
    if (!ready || !currentPath || loading || working) {
      return;
    }

    setContextMenu(undefined);

    try {
      const selectedPaths = await invoke<string[]>('pick_local_files');
      await handleUploadPaths(selectedPaths);
    } catch (nextError) {
      setToast({
        message: String(nextError),
        tone: 'error',
      });
    }
  };

  const handleSelectUploadFolder = async () => {
    if (!ready || !currentPath || loading || working) {
      return;
    }

    setContextMenu(undefined);

    try {
      const selectedPaths = await invoke<string[]>('pick_local_folder');
      await handleUploadPaths(selectedPaths);
    } catch (nextError) {
      setToast({
        message: String(nextError),
        tone: 'error',
      });
    }
  };

  const handleCancelUpload = async () => {
    if (!uploadProgress || uploadProgress.cancelling || !sessionId) {
      return;
    }

    const operationId = uploadProgress.operationId;
    fileManagerLogger.info('请求取消上传', { sessionId, operationId });
    updateSessionState(sessionId, (current) =>
      current.uploadProgress?.operationId === operationId
        ? {
            uploadProgress: {
              ...current.uploadProgress,
              cancelling: true,
            },
          }
        : {},
    );

    try {
      await invoke('cancel_upload', {
        operationId,
      });
    } catch (nextError) {
      fileManagerLogger.error('取消上传失败', { sessionId, operationId, error: String(nextError) });
      updateSessionState(sessionId, (current) =>
        current.uploadProgress?.operationId === operationId
          ? {
              uploadProgress: {
                ...current.uploadProgress,
                cancelling: false,
              },
            }
          : {},
      );
      setToast({
        message: String(nextError),
        tone: 'error',
      });
    }
  };

  useEffect(() => {
    return () => {
      uploadConflictResolverRef.current?.('cancel', false);
      uploadConflictResolverRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (listing) {
      hasLoadedAnyListingRef.current = true;
    }
  }, [listing]);

  useEffect(() => {
    const api = gridRef.current?.api;
    if (!api) {
      return;
    }

    let hasSelectedRow = false;
    api.forEachNode((node) => {
      const shouldSelect = !!selectedPath && node.data?.path === selectedPath;
      if (node.isSelected() !== shouldSelect) {
        node.setSelected(shouldSelect);
      }
      if (shouldSelect) {
        hasSelectedRow = true;
      }
    });

    if (!hasSelectedRow && api.getSelectedRows().length) {
      api.deselectAll();
    }
  }, [selectedPath, listing]);

  useEffect(() => {
    setClipboard(undefined);
    setPendingDelete(undefined);
    setProperties(undefined);
    setDialog(undefined);
    setContextMenu(undefined);
    setToast(undefined);
    setDragActive(false);
    setDeleteProgress(undefined);

    if (!ready) {
      return;
    }

    if (listing) {
      return;
    }

    void loadDirectory();
  }, [ready, sessionId, listing]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(undefined);
    window.addEventListener('click', closeMenu);

    return () => {
      window.removeEventListener('click', closeMenu);
    };
  }, []);

  useLayoutEffect(() => {
    if (!contextMenu || !menuRef.current) {
      return;
    }

    const rect = menuRef.current.getBoundingClientRect();
    const nextPosition = clampMenuPosition(contextMenu.x, contextMenu.y, rect.width, rect.height);

    if (nextPosition.x === contextMenu.x && nextPosition.y === contextMenu.y) {
      return;
    }

    setContextMenu((current) =>
      current
        ? {
            ...current,
            x: nextPosition.x,
            y: nextPosition.y,
          }
        : current,
    );
  }, [contextMenu]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let dispose: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      const unlisten = await listen<UploadProgressEvent>('upload-progress', (event) => {
        const operationId = event.payload.operationId;
        const targetSessionId = uploadSessionByOperationRef.current[operationId];
        if (!targetSessionId) {
          return;
        }

        updateSessionState(targetSessionId, (current) =>
          current.uploadProgress?.operationId === operationId
            ? {
                uploadProgress: {
                  operationId: event.payload.operationId,
                  currentPath: event.payload.currentPath,
                  totalBytes: event.payload.totalBytes,
                  uploadedBytes: event.payload.uploadedBytes,
                  totalSteps: event.payload.totalSteps,
                  completedSteps: event.payload.completedSteps,
                  cancelling: current.uploadProgress.cancelling,
                },
              }
            : {},
        );
      });

      if (cancelled) {
        unlisten();
        return;
      }

      dispose = unlisten;
    };

    void attach();

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [updateSessionState]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let dispose: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      const unlisten = await listen<DeleteProgressEvent>('delete-progress', (event) => {
        setDeleteProgress((current) =>
          current && current.operationId === event.payload.operationId
            ? {
                operationId: event.payload.operationId,
                currentPath: event.payload.currentPath,
                totalSteps: event.payload.totalSteps,
                completedSteps: event.payload.completedSteps,
                cancelling: current.cancelling,
              }
            : current,
        );
      });

      if (cancelled) {
        unlisten();
        return;
      }

      dispose = unlisten;
    };

    void attach();

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let dispose: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      const unlisten = await listen<DownloadProgressEvent>('download-progress', (event) => {
        setDownloadProgress((current) =>
          current && current.operationId === event.payload.operationId
            ? {
                operationId: event.payload.operationId,
                currentPath: event.payload.currentPath,
                totalBytes: event.payload.totalBytes,
                downloadedBytes: event.payload.downloadedBytes,
                totalSteps: event.payload.totalSteps,
                completedSteps: event.payload.completedSteps,
                cancelling: current.cancelling,
              }
            : current,
        );
      });

      if (cancelled) {
        unlisten();
        return;
      }

      dispose = unlisten;
    };

    void attach();

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let dispose: (() => void) | undefined;
    let cancelled = false;

    const attach = async () => {
      const unlisten = await getCurrentWindow().onDragDropEvent((event) => {
        if (!canProcessWindowDragDrop(latestWindowDropStateRef.current)) {
          setDragActive(false);
          return;
        }

        switch (event.payload.type) {
          case 'enter':
          case 'over':
            setDragActive(true);
            break;
          case 'leave':
            setDragActive(false);
            break;
          case 'drop':
            setDragActive(false);
            void uploadPathsRef.current(event.payload.paths);
            break;
        }
      });

      if (cancelled) {
        unlisten();
        return;
      }

      dispose = unlisten;
    };

    void attach();

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  const submitDialog = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!ready || !dialog || !connection || !currentPath) {
      return;
    }

    if (dialog.mode === 'rename') {
      if (!selectedEntry) {
        return;
      }

      await runFileAction(
        () =>
          invoke('rename_remote_path', {
            request: {
              ...connection,
              path: selectedEntry.path,
              newName: dialog.value,
            },
          }),
        t('fileManager.feedback.renameSuccess'),
      );
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
  };

  const openRenameDialog = (entry?: RemoteFileEntry) => {
    if (!ready) {
      return;
    }
    const target = entry ?? selectedEntry;
    if (!target) {
      return;
    }

    setSelectedPath(target.path);
    setContextMenu(undefined);
    setDialog({
      mode: 'rename',
      value: target.name,
    });
  };

  const openProperties = (entry?: RemoteFileEntry) => {
    if (!ready) {
      return;
    }
    const target = entry ?? selectedEntry;
    if (!target) {
      return;
    }

    setSelectedPath(target.path);
    setContextMenu(undefined);
    setProperties({
      entry: target,
      directoryPath: target.kind === 'directory' ? target.path : parentDirectoryPath(target.path),
    });
  };

  const handleDelete = (entry?: RemoteFileEntry) => {
    if (!ready) {
      return;
    }
    const target = entry ?? selectedEntry;
    if (!target || !connection) {
      return;
    }

    setSelectedPath(target.path);
    setContextMenu(undefined);
    setPendingDelete({
      path: target.path,
      name: target.name,
      kind: target.kind,
    });
  };

  const handleDownload = async (entry?: RemoteFileEntry) => {
    if (!ready) {
      return;
    }
    const target = entry ?? selectedEntry;
    if (!target || !connection || !sessionId) {
      return;
    }

    setSelectedPath(target.path);
    setContextMenu(undefined);

    let destinationDirectory: string;
    try {
      const selected = await invoke<string[]>('pick_local_folder');
      if (!selected.length) {
        return;
      }
      destinationDirectory = selected[0];
    } catch (nextError) {
      setToast({
        message: String(nextError),
        tone: 'error',
      });
      return;
    }

    const operationId = createOperationId();
    fileManagerLogger.info('开始下载', {
      sessionId,
      operationId,
      remotePath: target.path,
      destinationDirectory,
    });
    setWorking(true);
    setFileError(undefined);
    setToast(undefined);
    setDownloadProgress({
      operationId,
      currentPath: target.path,
      totalBytes: 0,
      downloadedBytes: 0,
      totalSteps: 1,
      completedSteps: 0,
      cancelling: false,
    });

    try {
      await invoke('download_remote_paths', {
        request: {
          ...connection,
          remotePaths: [target.path],
          destinationDirectory,
          operationId,
        },
      });
      setToast({
        message: t('fileManager.feedback.downloadSingle', { name: target.name }),
        tone: 'success',
      });
      fileManagerLogger.info('下载完成', {
        sessionId,
        operationId,
        remotePath: target.path,
        destinationDirectory,
      });
    } catch (nextError) {
      const message = String(nextError);
      const cancelled = message.includes('download cancelled');
      if (cancelled) {
        fileManagerLogger.info('下载已取消', { sessionId, operationId, remotePath: target.path });
      } else {
        fileManagerLogger.error('下载失败', {
          sessionId,
          operationId,
          remotePath: target.path,
          error: message,
        });
      }
      setToast({
        message: cancelled ? t('fileManager.feedback.downloadCancelled') : message,
        tone: cancelled ? 'info' : 'error',
      });
    } finally {
      setDownloadProgress(undefined);
      setWorking(false);
    }
  };

  const handleCancelDownload = async () => {
    if (!downloadProgress || downloadProgress.cancelling) {
      return;
    }

    const operationId = downloadProgress.operationId;
    fileManagerLogger.info('请求取消下载', { sessionId, operationId });
    setDownloadProgress((current) =>
      current && current.operationId === operationId
        ? {
            ...current,
            cancelling: true,
          }
        : current,
    );

    try {
      await invoke('cancel_download', {
        operationId,
      });
    } catch (nextError) {
      fileManagerLogger.error('取消下载失败', { sessionId, operationId, error: String(nextError) });
      setDownloadProgress((current) =>
        current && current.operationId === operationId
          ? {
              ...current,
              cancelling: false,
            }
          : current,
      );
      setToast({
        message: String(nextError),
        tone: 'error',
      });
    }
  };

  const handleCopy = (entry?: RemoteFileEntry) => {
    const target = entry ?? selectedEntry;
    if (!target) {
      return;
    }

    setSelectedPath(target.path);
    setClipboard({
      sourcePath: target.path,
      sourceName: target.name,
      kind: target.kind,
    });
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
    setContextMenu(undefined);
  };

  const handleCopyText = async (label: string, value: string) => {
    setContextMenu(undefined);

    try {
      await writeClipboardText(value);
      setToast({
        message: t('fileManager.feedback.copiedLabel', { label }),
        tone: 'success',
      });
    } catch (nextError) {
      setToast({
        message: String(nextError),
        tone: 'error',
      });
    }
  };

  const clearClipboardNotice = () => {
    setClipboard(undefined);
    setToast(undefined);
  };

  const confirmDelete = async () => {
    if (!ready || !pendingDelete || !connection) {
      return;
    }

    const target = pendingDelete;
    const operationId = createOperationId();
    fileManagerLogger.info('开始删除远程路径', {
      sessionId,
      operationId,
      path: target.path,
      kind: target.kind,
    });

    setWorking(true);
    setFileError(undefined);
    setToast(undefined);
    setContextMenu(undefined);
    setPendingDelete(undefined);
    setDeleteProgress({
      operationId,
      currentPath: target.path,
      totalSteps: 1,
      completedSteps: 0,
      cancelling: false,
    });

    try {
      await invoke('delete_remote_path', {
        request: {
          ...connection,
          path: target.path,
          operationId,
        },
      });
      setDialog(undefined);
      setProperties(undefined);
      setSelectedPath(undefined);
      await loadDirectory(currentPath);
      setToast({
        message: t('fileManager.feedback.deleteSuccess'),
        tone: 'success',
      });
      fileManagerLogger.info('删除完成', { sessionId, operationId, path: target.path });
    } catch (nextError) {
      const message = String(nextError);
      const cancelled = message.includes('delete cancelled');
      if (cancelled) {
        await loadDirectory(currentPath);
      }
      if (cancelled) {
        fileManagerLogger.info('删除已取消', { sessionId, operationId, path: target.path });
      } else {
        fileManagerLogger.error('删除失败', {
          sessionId,
          operationId,
          path: target.path,
          error: message,
        });
      }
      setToast({
        message: cancelled ? t('fileManager.feedback.deleteCancelled') : message,
        tone: cancelled ? 'info' : 'error',
      });
    } finally {
      setDeleteProgress(undefined);
      setWorking(false);
    }
  };

  const handleCancelDelete = async () => {
    if (!deleteProgress || deleteProgress.cancelling) {
      return;
    }

    const operationId = deleteProgress.operationId;
    fileManagerLogger.info('请求取消删除', { sessionId, operationId });
    setDeleteProgress((current) =>
      current && current.operationId === operationId
        ? {
            ...current,
            cancelling: true,
          }
        : current,
    );

    try {
      await invoke('cancel_delete', {
        operationId,
      });
    } catch (nextError) {
      fileManagerLogger.error('取消删除失败', { sessionId, operationId, error: String(nextError) });
      setDeleteProgress((current) =>
        current && current.operationId === operationId
          ? {
              ...current,
              cancelling: false,
            }
          : current,
      );
      setToast({
        message: String(nextError),
        tone: 'error',
      });
    }
  };

  const handlePaste = async () => {
    if (!ready || !clipboard || !connection || !currentPath) {
      return;
    }

    await runFileAction(
      () =>
        invoke('copy_remote_path', {
          request: {
            ...connection,
            sourcePath: clipboard.sourcePath,
            destinationDirectory: currentPath,
          },
        }),
      t('fileManager.feedback.paste', { name: clipboard.sourceName }),
    );
  };

  const handleOpenWithDefaultEditor = async (entry?: RemoteFileEntry) => {
    if (!ready) {
      return;
    }
    const target = entry ?? selectedEntry;
    if (!target || !connection || target.kind === 'directory') {
      return;
    }

    setSelectedPath(target.path);
    setContextMenu(undefined);
    setWorking(true);
    setToast(undefined);

    try {
      await invoke('open_remote_file', {
        request: {
          ...connection,
          path: target.path,
        },
      });
      setToast({
        message: t('fileManager.feedback.openDefault', { name: target.name }),
        tone: 'success',
      });
      fileManagerLogger.info('已请求默认应用打开文件', {
        sessionId,
        path: target.path,
      });
    } catch (nextError) {
      fileManagerLogger.error('默认应用打开文件失败', {
        sessionId,
        path: target.path,
        error: String(nextError),
      });
      setToast({
        message: String(nextError),
        tone: 'error',
      });
    } finally {
      setWorking(false);
    }
  };

  const handlePathSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready) {
      return;
    }
    const nextPath = pathInput.trim();
    if (!nextPath) {
      return;
    }
    await loadDirectory(nextPath);
  };

  const openBlankMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!ready) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: 'blank',
    });
  };

  const openToolbarMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!ready) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({
      x: rect.left,
      y: rect.bottom + 6,
      target: 'toolbar',
    });
  };

  const handleGridRowClick = (event: RowClickedEvent<RemoteFileEntry>) => {
    if (!event.data) {
      return;
    }

    setSelectedPath(event.data.path);
  };

  const handleGridRowDoubleClick = (event: RowDoubleClickedEvent<RemoteFileEntry>) => {
    if (!ready || !event.data || event.data.kind !== 'directory') {
      return;
    }

    void loadDirectory(event.data.path);
  };

  const handleGridContextMenu = (event: CellContextMenuEvent<RemoteFileEntry>) => {
    if (!ready) {
      return;
    }
    const target = event.data;
    const mouseEvent = event.event as MouseEvent | undefined;
    if (!target || !mouseEvent) {
      return;
    }

    mouseEvent.preventDefault();
    mouseEvent.stopPropagation();
    setSelectedPath(target.path);
    setContextMenu({
      x: mouseEvent.clientX,
      y: mouseEvent.clientY,
      target: 'entry',
      entry: target,
    });
  };

  return (
    <aside className="surface rounded-lg relative flex min-h-0 flex-col overflow-hidden font-['PingFang_SC','Hiragino_Sans_GB','Microsoft_YaHei_UI','Noto_Sans_SC','Source_Han_Sans_SC',sans-serif]">
      <div className="surface-header">
        <div className="min-w-0">
          <p className="label">{t('fileManager.subtitle')}</p>
          <h3 className="themed-heading truncate text-[13px] font-semibold tracking-[0.01em]">
            {session ? t('fileManager.title.active') : t('fileManager.title.inactive')}
          </h3>
        </div>
        <div className="flex items-center gap-1">
          <span className="file-manager-count rounded-md px-2 py-1 text-[10px]">{listing?.entries.length ?? 0}</span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 p-1">
        {!session ? (
          <div className="surface-muted rounded-lg flex flex-1 items-center justify-center p-3 text-center text-xs text-slate-400">
            {t('fileManager.empty.noSession')}
          </div>
        ) : session.status !== 'connected' && !listing && showInitialLoadingHint ? (
          <div className="surface-muted flex flex-1 items-center justify-center p-3 text-center text-xs text-slate-400">
            {t('fileManager.empty.waitForSession')}
          </div>
        ) : (
          <>
            <form className="flex items-center gap-1" onSubmit={(event) => void handlePathSubmit(event)}>
              <button
                className="icon-btn h-6 w-6 px-0"
                disabled={!ready || !listing?.parentPath || loading || working}
                onClick={() => listing?.parentPath && void loadDirectory(listing.parentPath)}
                title={t('fileManager.actions.parent')}
                type="button"
              >
                <ArrowUpIcon />
              </button>
              <input
                className="themed-input min-w-0 flex-1 px-2 py-0.5 font-mono text-[12px] leading-5 outline-none transition focus:ring-1 focus:ring-cyan-400/50"
                disabled={readOnly || loading || working}
                onChange={(event) => setPathInput(event.target.value)}
                placeholder={t('fileManager.pathPlaceholder')}
                value={pathInput}
              />
              <button
                className="icon-btn h-6 w-6 px-0"
                disabled={!ready || loading || working}
                onClick={() => void loadDirectory(currentPath)}
                title={t('fileManager.actions.refresh')}
                type="button"
              >
                <RefreshIcon />
              </button>
              <button
                className="icon-btn h-6 w-6 px-0"
                disabled={!ready || !currentPath || loading || working}
                onClick={openToolbarMenu}
                title={t('fileManager.actions.more')}
                type="button"
              >
                <DotsIcon />
              </button>
            </form>

            {error ? <div className="rounded-lg border border-rose-900 bg-rose-950/40 px-2 py-2 text-xs text-rose-300">{error}</div> : null}
            {readOnly && listing ? (
              <div className="rounded-lg border border-amber-900/80 bg-amber-950/30 px-2 py-2 text-xs text-amber-200">
                {t('fileManager.readOnly')}
              </div>
            ) : null}

            <ScrollArea
              className="flex-1 rounded-lg"
              onMouseDown={(event) => {
                if (event.button === 2) {
                  event.preventDefault();
                }
              }}
              onContextMenu={openBlankMenu}
            >
              {loading && !listing ? (
                showInitialLoadingHint ? (
                  <div className="surface-muted rounded-lg px-2 py-2 text-xs text-slate-400">{t('fileManager.loading')}</div>
                ) : null
              ) : !listing ? null : (
                <div className="ag-theme-quartz termbridge-file-grid h-full">
                  <AgGridReact<RemoteFileEntry>
                    animateRows={false}
                    defaultColDef={defaultColDef}
                    columnDefs={columnDefs}
                    getRowId={(params) => params.data.path}
                    headerHeight={26}
                    noRowsOverlayComponentParams={{
                      message: t('fileManager.emptyDirectory'),
                    }}
                    onCellContextMenu={handleGridContextMenu}
                    onRowClicked={handleGridRowClick}
                    onRowDoubleClicked={handleGridRowDoubleClick}
                    overlayNoRowsTemplate={`<span class="termbridge-grid-overlay">${t('fileManager.emptyDirectory')}</span>`}
                    ref={gridRef}
                    rowSelection={{ mode: 'singleRow', checkboxes: false }}
                    rowData={listing.entries}
                    rowHeight={28}
                    suppressCellFocus
                    suppressContextMenu
                    suppressDragLeaveHidesColumns
                    theme="legacy"
                  />
                </div>
              )}
            </ScrollArea>
          </>
        )}
      </div>

      {contextMenu
        ? createPortal(
            <div
              className="themed-menu fixed z-50 min-w-33 rounded-lg p-1 backdrop-blur"
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
              onMouseDown={(event) => {
                if (event.button === 2) {
                  event.preventDefault();
                }
              }}
              ref={menuRef}
              style={{ left: contextMenu.x, top: contextMenu.y }}
            >
              {contextMenu.target === 'entry' ? (
                <div className="flex flex-col">
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.newFile')}
                    onClick={() => openCreateDialog('newFile')}
                  />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.newDirectory')}
                    onClick={() => openCreateDialog('newDirectory')}
                  />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.uploadFile')}
                    onClick={() => void handleSelectUploadFiles()}
                  />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.uploadFolder')}
                    onClick={() => void handleSelectUploadFolder()}
                  />
                  {contextMenu.entry?.kind === 'directory' ? (
                    <MenuButton
                      disabled={!ready || loading || working}
                      label={t('fileManager.menu.open')}
                      onClick={() => {
                        if (contextMenu.entry) {
                          void loadDirectory(contextMenu.entry.path);
                        }
                      }}
                    />
                  ) : null}
                  {contextMenu.entry && contextMenu.entry.kind !== 'directory' ? (
                    <MenuButton
                      disabled={!ready || loading || working}
                      label={t('fileManager.menu.openWithDefaultEditor')}
                      onClick={() => void handleOpenWithDefaultEditor(contextMenu.entry)}
                    />
                  ) : null}
                  <MenuDivider />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.download')}
                    onClick={() => void handleDownload(contextMenu.entry)}
                  />
                  <MenuDivider />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.rename')}
                    onClick={() => openRenameDialog(contextMenu.entry)}
                  />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.copy')}
                    onClick={() => handleCopy(contextMenu.entry)}
                  />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.delete')}
                    onClick={() => handleDelete(contextMenu.entry)}
                  />
                  <MenuDivider />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.copyName')}
                    onClick={() => void handleCopyText(t('fileManager.copyLabel.name'), contextMenu.entry?.name ?? '')}
                  />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={contextMenu.entry?.kind === 'directory' ? t('fileManager.menu.copyDirectoryPath') : t('fileManager.menu.copyFilePath')}
                    onClick={() =>
                      void handleCopyText(
                        contextMenu.entry?.kind === 'directory' ? t('fileManager.copyLabel.directoryPath') : t('fileManager.copyLabel.filePath'),
                        contextMenu.entry?.path ?? '',
                      )
                    }
                  />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.copyContainingDirectory')}
                    onClick={() =>
                      void handleCopyText(
                        t('fileManager.copyLabel.directoryPath'),
                        contextMenu.entry
                          ? contextMenu.entry.kind === 'directory'
                            ? contextMenu.entry.path
                            : parentDirectoryPath(contextMenu.entry.path)
                          : (currentPath ?? ''),
                      )
                    }
                  />
                  <MenuDivider />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.actions.refresh')}
                    onClick={() => void loadDirectory(currentPath)}
                  />
                  <MenuDivider />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.properties')}
                    onClick={() => openProperties(contextMenu.entry)}
                  />
                </div>
              ) : (
                <div className="flex flex-col">
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.newFile')}
                    onClick={() => openCreateDialog('newFile')}
                  />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.newDirectory')}
                    onClick={() => openCreateDialog('newDirectory')}
                  />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.uploadFile')}
                    onClick={() => void handleSelectUploadFiles()}
                  />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.menu.uploadFolder')}
                    onClick={() => void handleSelectUploadFolder()}
                  />
                  <MenuDivider />
                  <MenuButton
                    disabled={!ready || !clipboard || loading || working}
                    label={t('fileManager.menu.paste')}
                    onClick={() => void handlePaste()}
                  />
                  <MenuButton
                    disabled={!ready || !currentPath || loading || working}
                    label={t('fileManager.menu.copyCurrentDirectoryPath')}
                    onClick={() => void handleCopyText(t('fileManager.copyLabel.currentDirectoryPath'), currentPath ?? '')}
                  />
                  <MenuDivider />
                  <MenuButton
                    disabled={!ready || loading || working}
                    label={t('fileManager.actions.refresh')}
                    onClick={() => void loadDirectory(currentPath)}
                  />
                </div>
              )}
            </div>,
            document.body,
          )
        : null}

      {properties ? (
        <OverlayLayer>
          <OverlayPanel className="max-w-md">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="dialog-kicker text-[11px] font-medium tracking-[0.08em]">{t('fileManager.property.title')}</p>
                <h4 className="themed-heading mt-1 text-[15px] font-semibold tracking-[0.01em]">{properties.entry.name}</h4>
              </div>
              <button
                aria-label={t('fileManager.property.close')}
                className="icon-btn h-7 w-7 px-0"
                onClick={() => setProperties(undefined)}
                title={t('settings.close')}
                type="button"
              >
                <CloseIcon />
              </button>
            </div>

            <div className="grid gap-1">
              <PropertyRow label={t('fileManager.property.name')} value={properties.entry.name} />
              <PropertyRow label={t('fileManager.property.path')} value={properties.entry.path} />
              <PropertyRow label={t('fileManager.property.directory')} value={properties.directoryPath} />
              <PropertyRow label={t('fileManager.property.type')} value={kindLabel(properties.entry.kind)} />
              <PropertyRow
                label={t('fileManager.property.size')}
                value={properties.entry.kind === 'directory' ? '--' : formatSize(properties.entry.size)}
              />
              <PropertyRow label={t('fileManager.property.modified')} value={formatFullModified(properties.entry.modifiedAt)} />
              <PropertyRow
                label={t('fileManager.property.owner')}
                value={
                  properties.entry.ownerName
                    ? properties.entry.ownerUid !== undefined
                      ? `${properties.entry.ownerName} (UID ${properties.entry.ownerUid})`
                      : properties.entry.ownerName
                    : properties.entry.ownerUid !== undefined
                      ? `UID ${properties.entry.ownerUid}`
                      : '--'
                }
              />
              <PropertyRow
                label={t('fileManager.property.group')}
                value={
                  properties.entry.groupName
                    ? properties.entry.groupGid !== undefined
                      ? `${properties.entry.groupName} (GID ${properties.entry.groupGid})`
                      : properties.entry.groupName
                    : properties.entry.groupGid !== undefined
                      ? `GID ${properties.entry.groupGid}`
                      : '--'
                }
              />
              <PropertyRow label={t('fileManager.property.permissions')} value={formatPermissionOctal(properties.entry.permissions)} />
              <PropertyRow
                label={t('fileManager.property.permissionDetails')}
                value={formatPermissionSymbolic(properties.entry.permissions, properties.entry.kind)}
              />
            </div>
          </OverlayPanel>
        </OverlayLayer>
      ) : null}

      {uploadProgress ? (
        <OverlayLayer tone="progress">
          <OverlayPanel className="max-w-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="file-manager-progress-kicker text-[11px] font-medium tracking-[0.08em]">
                {uploadProgress.cancelling ? t('fileManager.uploadProgress.cancelling') : t('fileManager.uploadProgress.title')}
              </span>
              <span className="file-manager-progress-meta text-xs font-medium">{uploadProgressPercent(uploadProgress)}%</span>
            </div>

            <div className="file-manager-progress-track h-2 overflow-hidden rounded-full">
              <div
                className="file-manager-progress-bar file-manager-progress-bar--upload h-full rounded-full transition-[width] duration-150"
                style={{ width: `${uploadProgressPercent(uploadProgress)}%` }}
              />
            </div>

            <div className="flex flex-col gap-0.5">
              <strong className="file-manager-progress-title truncate text-sm">
                {uploadProgress.currentPath ? localPathName(uploadProgress.currentPath) : t('fileManager.uploadProgress.preparing')}
              </strong>
              <span className="file-manager-progress-meta text-xs">
                {uploadProgress.totalBytes > 0
                  ? `${formatSize(uploadProgress.uploadedBytes)} / ${formatSize(uploadProgress.totalBytes)}`
                  : t('fileManager.progress.items', { completed: uploadProgress.completedSteps, total: uploadProgress.totalSteps })}
              </span>
            </div>

            <div className="flex justify-end">
              <button className="icon-btn" disabled={uploadProgress.cancelling} onClick={() => void handleCancelUpload()} type="button">
                {uploadProgress.cancelling ? t('fileManager.uploadProgress.cancellingButton') : t('fileManager.uploadProgress.cancel')}
              </button>
            </div>
          </OverlayPanel>
        </OverlayLayer>
      ) : null}

      {deleteProgress ? (
        <OverlayLayer tone="progress">
          <OverlayPanel className="max-w-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="file-manager-progress-kicker text-[11px] font-medium tracking-[0.08em]">
                {deleteProgress.cancelling ? t('fileManager.deleteProgress.cancelling') : t('fileManager.deleteProgress.title')}
              </span>
              <span className="file-manager-progress-meta text-xs font-medium">{stepProgressPercent(deleteProgress)}%</span>
            </div>

            <div className="file-manager-progress-track h-2 overflow-hidden rounded-full">
              <div
                className="file-manager-progress-bar file-manager-progress-bar--delete h-full rounded-full transition-[width] duration-150"
                style={{ width: `${stepProgressPercent(deleteProgress)}%` }}
              />
            </div>

            <div className="flex flex-col gap-0.5">
              <strong className="file-manager-progress-title truncate text-sm">
                {deleteProgress.currentPath ? localPathName(deleteProgress.currentPath) : t('fileManager.deleteProgress.preparing')}
              </strong>
              <span className="file-manager-progress-meta text-xs">
                {t('fileManager.progress.items', { completed: deleteProgress.completedSteps, total: deleteProgress.totalSteps })}
              </span>
            </div>
            <div className="flex justify-end">
              <button className="icon-btn" disabled={deleteProgress.cancelling} onClick={() => void handleCancelDelete()} type="button">
                {deleteProgress.cancelling ? t('fileManager.deleteProgress.cancellingButton') : t('fileManager.deleteProgress.cancel')}
              </button>
            </div>
          </OverlayPanel>
        </OverlayLayer>
      ) : null}

      {downloadProgress ? (
        <OverlayLayer tone="progress">
          <OverlayPanel className="max-w-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="file-manager-progress-kicker text-[11px] font-medium tracking-[0.08em]">
                {downloadProgress.cancelling ? t('fileManager.downloadProgress.cancelling') : t('fileManager.downloadProgress.title')}
              </span>
              <span className="file-manager-progress-meta text-xs font-medium">{downloadProgressPercent(downloadProgress)}%</span>
            </div>

            <div className="file-manager-progress-track h-2 overflow-hidden rounded-full">
              <div
                className="file-manager-progress-bar file-manager-progress-bar--download h-full rounded-full transition-[width] duration-150"
                style={{ width: `${downloadProgressPercent(downloadProgress)}%` }}
              />
            </div>

            <div className="flex flex-col gap-0.5">
              <strong className="file-manager-progress-title truncate text-sm">
                {downloadProgress.currentPath ? localPathName(downloadProgress.currentPath) : t('fileManager.downloadProgress.preparing')}
              </strong>
              <span className="file-manager-progress-meta text-xs">
                {downloadProgress.totalBytes > 0
                  ? `${formatSize(downloadProgress.downloadedBytes)} / ${formatSize(downloadProgress.totalBytes)}`
                  : t('fileManager.progress.items', { completed: downloadProgress.completedSteps, total: downloadProgress.totalSteps })}
              </span>
            </div>

            <div className="flex justify-end">
              <button className="icon-btn" disabled={downloadProgress.cancelling} onClick={() => void handleCancelDownload()} type="button">
                {downloadProgress.cancelling ? t('fileManager.downloadProgress.cancellingButton') : t('fileManager.downloadProgress.cancel')}
              </button>
            </div>
          </OverlayPanel>
        </OverlayLayer>
      ) : null}

      {dragActive && ready && !uploadProgress && !deleteProgress && !downloadProgress ? (
        <OverlayLayer tone="progress">
          <OverlayPanel className="max-w-xs gap-1 text-center">
            <span className="file-manager-progress-kicker text-[11px] font-medium tracking-[0.08em]">{t('fileManager.dragDrop.title')}</span>
            <strong className="file-manager-progress-title text-[15px] font-semibold tracking-[0.01em]">
              {t('fileManager.dragDrop.description')}
            </strong>
            <span className="file-manager-progress-meta text-xs">{t('fileManager.dragDrop.hint')}</span>
          </OverlayPanel>
        </OverlayLayer>
      ) : null}

      {dialog ? (
        <OverlayLayer>
          <form className="surface flex w-full max-w-xs flex-col gap-2 p-3" onSubmit={(event) => void submitDialog(event)}>
            <div>
              <p className="dialog-kicker text-[11px] font-medium tracking-[0.08em]">
                {dialog.mode === 'rename' ? t('fileManager.dialog.rename') : t('fileManager.dialog.new')}
              </p>
              <h4 className="themed-heading mt-1 text-[15px] font-semibold tracking-[0.01em]">
                {dialog.mode === 'newFile'
                  ? t('fileManager.dialog.newFileTitle')
                  : dialog.mode === 'newDirectory'
                    ? t('fileManager.dialog.newDirectoryTitle')
                    : t('fileManager.dialog.renameTitle')}
              </h4>
            </div>

            <input
              autoFocus
              className="themed-input rounded-lg px-3 py-2 text-[13px] leading-5 outline-none transition focus:border-cyan-400/60"
              onChange={(event) => setDialog((current) => (current ? { ...current, value: event.target.value } : current))}
              placeholder={
                dialog.mode === 'newFile'
                  ? t('fileManager.dialog.newFilePlaceholder')
                  : dialog.mode === 'newDirectory'
                    ? t('fileManager.dialog.newDirectoryPlaceholder')
                    : t('fileManager.dialog.renamePlaceholder')
              }
              value={dialog.value}
            />

            <div className="flex justify-end gap-1">
              <button className="icon-btn h-8 px-3" onClick={() => setDialog(undefined)} type="button">
                {t('fileManager.dialog.cancel')}
              </button>
              <button className="primary-btn h-8 px-3 text-xs" disabled={!dialog.value.trim() || working} type="submit">
                {dialog.mode === 'rename' ? t('fileManager.dialog.save') : t('fileManager.dialog.confirm')}
              </button>
            </div>
          </form>
        </OverlayLayer>
      ) : null}

      {pendingUploadConflict ? (
        <OverlayLayer>
          <OverlayPanel className="app-dialog max-w-sm" role="dialog" aria-modal="true" aria-label={t('fileManager.uploadConflict.kicker')}>
            <div className="flex flex-col gap-1">
              <p className="dialog-kicker text-[11px] font-medium tracking-[0.08em]">{t('fileManager.uploadConflict.kicker')}</p>
              <h4 className="dialog-title text-[15px] font-semibold tracking-[0.01em]">
                {t('fileManager.uploadConflict.title', { name: pendingUploadConflict.conflict.targetName })}
              </h4>
              <p className="dialog-description text-xs leading-5">
                {t('fileManager.uploadConflict.description', { kind: kindLabel(pendingUploadConflict.conflict.existingKind) })}
              </p>
              <p
                className="themed-property-row break-all rounded-lg px-2 py-2 text-[11px] leading-5"
                title={pendingUploadConflict.conflict.localPath}
              >
                {t('fileManager.uploadConflict.source', { path: addPathWrapOpportunities(pendingUploadConflict.conflict.localPath) })}
              </p>
            </div>

            <label className="themed-checkbox-row flex items-center gap-2 rounded-lg px-2 py-2 text-[12px]">
              <input
                checked={pendingUploadConflict.applyToRemaining}
                className="themed-checkbox h-3.5 w-3.5"
                onChange={(event) =>
                  setPendingUploadConflict((current) =>
                    current
                      ? {
                          ...current,
                          applyToRemaining: event.target.checked,
                        }
                      : current,
                  )
                }
                type="checkbox"
              />
              <span>
                {t('fileManager.uploadConflict.applyRemaining')}
                {pendingUploadConflict.remainingConflicts > 0
                  ? t('fileManager.uploadConflict.remaining', { count: pendingUploadConflict.remainingConflicts })
                  : t('fileManager.uploadConflict.last')}
              </span>
            </label>

            <div className="flex justify-end gap-1">
              <button
                className="icon-btn h-8 px-3"
                onClick={() => {
                  uploadConflictResolverRef.current?.('cancel', pendingUploadConflict.applyToRemaining);
                  setPendingUploadConflict(undefined);
                }}
                type="button"
              >
                {t('fileManager.uploadConflict.cancel')}
              </button>
              <button
                className="icon-btn h-8 px-3"
                onClick={() => {
                  uploadConflictResolverRef.current?.('skip', pendingUploadConflict.applyToRemaining);
                  setPendingUploadConflict(undefined);
                }}
                type="button"
              >
                {t('fileManager.uploadConflict.skip')}
              </button>
              <button
                className="primary-btn h-8 px-3 text-xs"
                onClick={() => {
                  uploadConflictResolverRef.current?.('overwrite', pendingUploadConflict.applyToRemaining);
                  setPendingUploadConflict(undefined);
                }}
                type="button"
              >
                {t('fileManager.uploadConflict.overwrite')}
              </button>
            </div>
          </OverlayPanel>
        </OverlayLayer>
      ) : null}

      {pendingDelete ? (
        <OverlayLayer>
          <OverlayPanel className="app-dialog max-w-sm" role="dialog" aria-modal="true" aria-label={t('fileManager.deleteConfirm.kicker')}>
            <div className="flex flex-col gap-1">
              <p className="dialog-kicker text-[11px] font-medium tracking-[0.08em]">{t('fileManager.deleteConfirm.kicker')}</p>
              <h4 className="dialog-title text-[15px] font-semibold tracking-[0.01em]">
                {pendingDelete.kind === 'directory' ? t('fileManager.deleteConfirm.directoryTitle') : t('fileManager.deleteConfirm.fileTitle')}
              </h4>
              <p className="dialog-description text-xs leading-5">
                {pendingDelete.kind === 'directory'
                  ? t('fileManager.deleteConfirm.directoryDescription', { name: pendingDelete.name })
                  : t('fileManager.deleteConfirm.fileDescription', { name: pendingDelete.name })}
              </p>
            </div>

            <div className="flex justify-end gap-1">
              <button className="icon-btn h-8 px-3" onClick={() => setPendingDelete(undefined)} type="button">
                {t('fileManager.dialog.cancel')}
              </button>
              <button
                className="inline-flex h-8 items-center justify-center rounded-lg bg-rose-500 px-3 text-xs font-semibold text-white transition hover:bg-rose-400"
                onClick={() => void confirmDelete()}
                type="button"
              >
                {t('fileManager.deleteConfirm.confirm')}
              </button>
            </div>
          </OverlayPanel>
        </OverlayLayer>
      ) : null}

      <Toast
        action={toast?.action}
        message={toast?.message ?? ''}
        onClose={() => {
          if (clipboard && toast?.action) {
            clearClipboardNotice();
            return;
          }
          setToast(undefined);
        }}
        open={!!toast}
        tone={toast?.tone ?? 'info'}
      />
    </aside>
  );
}
