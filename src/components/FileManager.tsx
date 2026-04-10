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
import { type FormEvent, type MouseEvent as ReactMouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isTauriRuntime } from '../lib/tauri';
import { useFileManagerStore } from '../stores/fileManagerStore';
import { cn, fileKindTone } from '../lib/ui';
import { ArrowUpIcon, DotsIcon, FileIcon, FolderIcon, LinkIcon, RefreshIcon } from './Icons';
import { Toast, type ToastAction } from './Toast';
import type { DeleteProgressEvent, RemoteDirectoryListing, RemoteFileEntry, RemoteFileKind, SessionState, UploadProgressEvent } from '../types';

interface FileManagerProps {
  session?: SessionState;
}

type EntryDialogMode = 'newFile' | 'newDirectory' | 'rename';
type MenuTarget = 'blank' | 'entry';

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

interface UploadProgressState {
  operationId: string;
  currentPath?: string;
  totalBytes: number;
  uploadedBytes: number;
  totalSteps: number;
  completedSteps: number;
  cancelling?: boolean;
}

interface DeleteProgressState {
  operationId: string;
  currentPath?: string;
  totalSteps: number;
  completedSteps: number;
}

interface ContextMenuState {
  x: number;
  y: number;
  target: MenuTarget;
  entry?: RemoteFileEntry;
}

ModuleRegistry.registerModules([AllCommunityModule]);

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

  return new Intl.DateTimeFormat('zh-CN', {
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

  return new Intl.DateTimeFormat('zh-CN', {
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
      return '目录';
    case 'file':
      return '文件';
    case 'symlink':
      return '链接';
    case 'other':
      return '其他';
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
    <div className="flex min-w-0 items-center gap-[2px]">
      <span
        className={cn('inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md', fileKindTone(data.kind))}
      >
        {fileKindIcon(data.kind)}
      </span>
      <span className="truncate text-[13px] font-medium leading-5 tracking-[0.01em] text-slate-100">{data.name}</span>
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
      className="rounded-md px-2 py-1 text-left text-[12px] font-medium text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-500"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function MenuDivider() {
  return <div className="my-1 h-px bg-slate-800/90" />;
}

function PropertyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 rounded-lg border border-slate-800 bg-slate-950/70 px-2 py-2">
      <span className="text-[11px] font-medium tracking-[0.02em] text-slate-500">{label}</span>
      <span className="break-all text-[12px] leading-5 text-slate-200">{value}</span>
    </div>
  );
}

export function FileManager({ session }: FileManagerProps) {
  const gridRef = useRef<AgGridReact<RemoteFileEntry> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const hasLoadedAnyListingRef = useRef(false);
  const [clipboard, setClipboard] = useState<ClipboardState>();
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteState>();
  const [properties, setProperties] = useState<PropertiesState>();
  const [dialog, setDialog] = useState<EntryDialogState>();
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState>();
  const [deleteProgress, setDeleteProgress] = useState<DeleteProgressState>();
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
  const selectedEntry = useMemo(() => listing?.entries.find((entry) => entry.path === selectedPath), [listing, selectedPath]);
  const ready = !!session && session.status === 'connected' && !!connection;
  const currentPath = listing?.path;
  const showInitialLoadingHint = !hasLoadedAnyListingRef.current;
  const columnDefs = useMemo<ColDef<RemoteFileEntry>[]>(
    () => [
      {
        cellRenderer: NameCellRenderer,
        field: 'name',
        headerName: '名称',
        width: 240,
        minWidth: 120,
        resizable: true,
        suppressMovable: true,
        tooltipField: 'name',
        flex: 1,
      },
      {
        field: 'modifiedAt',
        headerName: '时间',
        width: 142,
        minWidth: 142,
        resizable: true,
        suppressMovable: true,
        valueFormatter: ({ data }) => (data ? formatModified(data.modifiedAt) : '--'),
        cellClass: 'tabular-nums',
      },
      {
        field: 'kind',
        headerName: '类型',
        width: 88,
        minWidth: 88,
        resizable: true,
        suppressMovable: true,
        valueGetter: ({ data }) => (data ? kindLabel(data.kind) : '--'),
        valueFormatter: ({ data }) => (data ? kindLabel(data.kind) : '--'),
      },
      {
        field: 'size',
        headerName: '大小',
        width: 84,
        minWidth: 84,
        resizable: true,
        suppressMovable: true,
        valueFormatter: ({ data }) => (data ? (data.kind === 'directory' ? '--' : formatSize(data.size)) : '--'),
      },
      {
        headerName: '权限',
        width: 148,
        minWidth: 148,
        resizable: true,
        suppressMovable: true,
        valueGetter: ({ data }) => (data ? formatPermissionSymbolic(data.permissions, data.kind) : '--'),
        valueFormatter: ({ data }) => (data ? formatPermissionSymbolic(data.permissions, data.kind) : '--'),
        cellClass: 'font-mono',
      },
      {
        headerName: '所有者',
        width: 88,
        minWidth: 88,
        resizable: true,
        suppressMovable: true,
        valueGetter: ({ data }) => (data ? formatOwner(data) : '--'),
        valueFormatter: ({ data }) => (data ? formatOwner(data) : '--'),
        cellClass: 'font-mono',
      },
      {
        headerName: '分组',
        width: 88,
        minWidth: 88,
        resizable: true,
        suppressMovable: true,
        valueGetter: ({ data }) => (data ? formatGroup(data) : '--'),
        valueFormatter: ({ data }) => (data ? formatGroup(data) : '--'),
        cellClass: 'font-mono',
      },
    ],
    [],
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
    if (!connection || !sessionId) {
      return;
    }

    setLoading(true);
    setFileError(undefined);
    setContextMenu(undefined);

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
    } catch (nextError) {
      setFileError(String(nextError));
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
      setToast({
        message: String(nextError),
        tone: 'error',
      });
    } finally {
      setWorking(false);
    }
  };

  const handleUploadPaths = async (paths: string[]) => {
    if (!connection || !currentPath) {
      return;
    }

    const nextPaths = [...new Set(paths)].filter(Boolean);
    if (!nextPaths.length) {
      return;
    }

    const operationId = createOperationId();
    setWorking(true);
    setFileError(undefined);
    setToast(undefined);
    setContextMenu(undefined);
    setUploadProgress({
      operationId,
      currentPath: nextPaths[0],
      totalBytes: 0,
      uploadedBytes: 0,
      totalSteps: nextPaths.length,
      completedSteps: 0,
      cancelling: false,
    });

    try {
      await invoke('upload_local_paths', {
        request: {
          ...connection,
          destinationDirectory: currentPath,
          localPaths: nextPaths,
          operationId,
        },
      });
      await loadDirectory(currentPath);
      setToast({
        message: nextPaths.length === 1 ? `已上传 ${localPathName(nextPaths[0])}` : `已上传 ${nextPaths.length} 项`,
        tone: 'success',
      });
    } catch (nextError) {
      const message = String(nextError);
      const cancelled = message.includes('upload cancelled');
      if (cancelled) {
        await loadDirectory(currentPath);
      }
      setToast({
        message: cancelled ? '已取消上传' : message,
        tone: cancelled ? 'info' : 'error',
      });
    } finally {
      setUploadProgress(undefined);
      setWorking(false);
    }
  };

  const handleCancelUpload = async () => {
    if (!uploadProgress || uploadProgress.cancelling) {
      return;
    }

    setUploadProgress((current) => (current ? { ...current, cancelling: true } : current));

    try {
      await invoke('cancel_upload', {
        operationId: uploadProgress.operationId,
      });
    } catch (nextError) {
      setUploadProgress((current) => (current ? { ...current, cancelling: false } : current));
      setToast({
        message: String(nextError),
        tone: 'error',
      });
    }
  };

  useEffect(() => {
    if (listing) {
      hasLoadedAnyListingRef.current = true;
    }
  }, [listing]);

  useEffect(() => {
    gridRef.current?.api?.redrawRows();
  }, [selectedPath, listing]);

  useEffect(() => {
    setClipboard(undefined);
    setPendingDelete(undefined);
    setProperties(undefined);
    setDialog(undefined);
    setContextMenu(undefined);
    setToast(undefined);
    setDragActive(false);
    setUploadProgress(undefined);
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
        setUploadProgress((current) =>
          current && current.operationId === event.payload.operationId
            ? {
                operationId: event.payload.operationId,
                currentPath: event.payload.currentPath,
                totalBytes: event.payload.totalBytes,
                uploadedBytes: event.payload.uploadedBytes,
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
      const unlisten = await listen<DeleteProgressEvent>('delete-progress', (event) => {
        setDeleteProgress((current) =>
          current && current.operationId === event.payload.operationId
            ? {
                operationId: event.payload.operationId,
                currentPath: event.payload.currentPath,
                totalSteps: event.payload.totalSteps,
                completedSteps: event.payload.completedSteps,
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
        if (!ready || !currentPath) {
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
            void handleUploadPaths(event.payload.paths);
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
  }, [ready, currentPath]);

  const submitDialog = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!dialog || !connection || !currentPath) {
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
        '重命名成功',
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
      dialog.mode === 'newFile' ? '文件已创建' : '文件夹已创建',
    );
  };

  const openRenameDialog = (entry?: RemoteFileEntry) => {
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
      message: `已复制 ${target.name}`,
      tone: 'success',
      action: {
        label: '清除',
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
        message: `${label}已复制`,
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
    if (!pendingDelete || !connection) {
      return;
    }

    const target = pendingDelete;
    const operationId = createOperationId();

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
        message: '删除成功',
        tone: 'success',
      });
    } catch (nextError) {
      setToast({
        message: String(nextError),
        tone: 'error',
      });
    } finally {
      setDeleteProgress(undefined);
      setWorking(false);
    }
  };

  const handlePaste = async () => {
    if (!clipboard || !connection || !currentPath) {
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
      `已粘贴 ${clipboard.sourceName}`,
    );
  };

  const handleOpenWithDefaultEditor = async (entry?: RemoteFileEntry) => {
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
        message: `已使用默认应用打开 ${target.name}`,
        tone: 'success',
      });
    } catch (nextError) {
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
    const nextPath = pathInput.trim();
    if (!nextPath) {
      return;
    }
    await loadDirectory(nextPath);
  };

  const openBlankMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      target: 'blank',
    });
  };

  const handleGridRowClick = (event: RowClickedEvent<RemoteFileEntry>) => {
    if (!event.data) {
      return;
    }

    setSelectedPath(event.data.path);
  };

  const handleGridRowDoubleClick = (event: RowDoubleClickedEvent<RemoteFileEntry>) => {
    if (!event.data || event.data.kind !== 'directory') {
      return;
    }

    void loadDirectory(event.data.path);
  };

  const handleGridContextMenu = (event: CellContextMenuEvent<RemoteFileEntry>) => {
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
    <aside className="surface relative flex min-h-0 flex-col overflow-hidden font-['PingFang_SC','Hiragino_Sans_GB','Microsoft_YaHei_UI','Noto_Sans_SC','Source_Han_Sans_SC',sans-serif]">
      <div className="surface-header">
        <div className="min-w-0">
          <p className="text-[11px] font-medium tracking-[0.08em] text-cyan-300/80">文件</p>
          <h3 className="truncate text-[15px] font-semibold tracking-[0.01em] text-slate-100">{session ? '远程文件管理器' : '未激活会话'}</h3>
        </div>
        <div className="flex items-center gap-1">
          <span className="rounded-md bg-slate-950/70 px-2 py-1 text-[10px] text-slate-400">{listing?.entries.length ?? 0}</span>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 p-1">
        {!session ? (
          <div className="surface-muted flex flex-1 items-center justify-center p-3 text-center text-xs text-slate-400">
            先打开一个 SSH 会话，左侧会显示远程目录。
          </div>
        ) : session.status !== 'connected' && !listing && showInitialLoadingHint ? (
          <div className="surface-muted flex flex-1 items-center justify-center p-3 text-center text-xs text-slate-400">
            会话连接成功后，文件管理器会自动加载远程目录。
          </div>
        ) : (
          <>
            <form className="surface-muted flex items-center gap-1 px-2 py-2" onSubmit={(event) => void handlePathSubmit(event)}>
              <button
                className="icon-btn h-7 w-7 px-0"
                disabled={!ready || loading || working}
                onClick={() => void loadDirectory(currentPath)}
                title="刷新"
                type="button"
              >
                <RefreshIcon />
              </button>
              <input
                className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[12px] leading-5 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60"
                onChange={(event) => setPathInput(event.target.value)}
                placeholder="输入远程路径并回车"
                value={pathInput}
              />
              <button
                className="icon-btn h-7 w-7 px-0"
                disabled={!listing?.parentPath || loading || working}
                onClick={() => listing?.parentPath && void loadDirectory(listing.parentPath)}
                title="返回上级目录"
                type="button"
              >
                <ArrowUpIcon />
              </button>
            </form>

            {error ? <div className="rounded-lg border border-rose-900 bg-rose-950/40 px-2 py-2 text-xs text-rose-300">{error}</div> : null}

            <div
              className="min-h-0 flex-1 overflow-auto rounded-lg"
              onMouseDown={(event) => {
                if (event.button === 2) {
                  event.preventDefault();
                }
              }}
              onContextMenu={openBlankMenu}
            >
              {loading && !listing ? (
                showInitialLoadingHint ? (
                  <div className="surface-muted px-2 py-2 text-xs text-slate-400">正在加载远程目录...</div>
                ) : null
              ) : !listing ? null : (
                <div className="ag-theme-quartz termbridge-file-grid h-full">
                  <AgGridReact<RemoteFileEntry>
                    animateRows
                    defaultColDef={defaultColDef}
                    columnDefs={columnDefs}
                    getRowClass={(params) =>
                      params.data?.path === selectedPath ? 'termbridge-file-row termbridge-file-row-selected' : 'termbridge-file-row'
                    }
                    getRowId={(params) => params.data.path}
                    headerHeight={30}
                    noRowsOverlayComponentParams={{
                      message: '当前目录没有可显示的文件。',
                    }}
                    onCellContextMenu={handleGridContextMenu}
                    onRowClicked={handleGridRowClick}
                    onRowDoubleClicked={handleGridRowDoubleClick}
                    overlayNoRowsTemplate={'<span class="termbridge-grid-overlay">当前目录没有可显示的文件。</span>'}
                    ref={gridRef}
                    rowData={listing.entries}
                    rowHeight={32}
                    suppressCellFocus
                    suppressContextMenu
                    suppressDragLeaveHidesColumns
                  />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {contextMenu
        ? createPortal(
            <div
              className="fixed z-50 min-w-[132px] rounded-lg border border-slate-800 bg-slate-950/95 p-1 shadow-[0_12px_36px_rgba(2,6,23,0.45)] backdrop-blur"
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
              {contextMenu.target === 'blank' ? (
                <div className="flex flex-col">
                  <MenuButton
                    disabled={loading || working}
                    label="新建文件"
                    onClick={() => {
                      setDialog({ mode: 'newFile', value: '' });
                      setContextMenu(undefined);
                    }}
                  />
                  <MenuButton
                    disabled={loading || working}
                    label="新建文件夹"
                    onClick={() => {
                      setDialog({ mode: 'newDirectory', value: '' });
                      setContextMenu(undefined);
                    }}
                  />
                  <MenuDivider />
                  <MenuButton disabled={!clipboard || loading || working} label="粘贴" onClick={() => void handlePaste()} />
                  <MenuButton
                    disabled={!currentPath || loading || working}
                    label="复制当前目录路径"
                    onClick={() => void handleCopyText('当前目录路径', currentPath ?? '')}
                  />
                  <MenuDivider />
                  <MenuButton disabled={loading || working} label="刷新" onClick={() => void loadDirectory(currentPath)} />
                </div>
              ) : (
                <div className="flex flex-col">
                  <MenuButton
                    disabled={loading || working}
                    label="新建文件"
                    onClick={() => {
                      setDialog({ mode: 'newFile', value: '' });
                      setContextMenu(undefined);
                    }}
                  />
                  <MenuButton
                    disabled={loading || working}
                    label="新建文件夹"
                    onClick={() => {
                      setDialog({ mode: 'newDirectory', value: '' });
                      setContextMenu(undefined);
                    }}
                  />
                  {contextMenu.entry?.kind === 'directory' ? (
                    <MenuButton
                      disabled={loading || working}
                      label="打开"
                      onClick={() => {
                        if (contextMenu.entry) {
                          void loadDirectory(contextMenu.entry.path);
                        }
                      }}
                    />
                  ) : null}
                  {contextMenu.entry && contextMenu.entry.kind !== 'directory' ? (
                    <MenuButton
                      disabled={loading || working}
                      label="默认编辑器打开"
                      onClick={() => void handleOpenWithDefaultEditor(contextMenu.entry)}
                    />
                  ) : null}
                  <MenuDivider />
                  <MenuButton disabled={loading || working} label="重命名" onClick={() => openRenameDialog(contextMenu.entry)} />
                  <MenuButton disabled={loading || working} label="复制" onClick={() => handleCopy(contextMenu.entry)} />
                  <MenuDivider />
                  <MenuButton
                    disabled={loading || working}
                    label="复制名称"
                    onClick={() => void handleCopyText('名称', contextMenu.entry?.name ?? '')}
                  />
                  <MenuButton
                    disabled={loading || working}
                    label={contextMenu.entry?.kind === 'directory' ? '复制目录路径' : '复制文件路径'}
                    onClick={() =>
                      void handleCopyText(contextMenu.entry?.kind === 'directory' ? '目录路径' : '文件路径', contextMenu.entry?.path ?? '')
                    }
                  />
                  <MenuButton
                    disabled={loading || working}
                    label="复制所在目录"
                    onClick={() =>
                      void handleCopyText(
                        '目录路径',
                        contextMenu.entry
                          ? contextMenu.entry.kind === 'directory'
                            ? contextMenu.entry.path
                            : parentDirectoryPath(contextMenu.entry.path)
                          : (currentPath ?? ''),
                      )
                    }
                  />
                  <MenuDivider />
                  <MenuButton disabled={loading || working} label="属性" onClick={() => openProperties(contextMenu.entry)} />
                  <MenuButton disabled={loading || working} label="刷新" onClick={() => void loadDirectory(currentPath)} />
                  <MenuDivider />
                  <MenuButton disabled={loading || working} label="删除" onClick={() => handleDelete(contextMenu.entry)} />
                </div>
              )}
            </div>,
            document.body,
          )
        : null}

      {properties ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/70 p-2 backdrop-blur-sm">
          <div className="surface flex w-full max-w-md flex-col gap-2 p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-[11px] font-medium tracking-[0.08em] text-cyan-300/80">属性</p>
                <h4 className="mt-1 text-[15px] font-semibold tracking-[0.01em] text-slate-100">{properties.entry.name}</h4>
              </div>
              <button className="icon-btn" onClick={() => setProperties(undefined)} type="button">
                关闭
              </button>
            </div>

            <div className="grid gap-1">
              <PropertyRow label="名称" value={properties.entry.name} />
              <PropertyRow label="路径" value={properties.entry.path} />
              <PropertyRow label="所在目录" value={properties.directoryPath} />
              <PropertyRow label="类型" value={kindLabel(properties.entry.kind)} />
              <PropertyRow label="大小" value={properties.entry.kind === 'directory' ? '--' : formatSize(properties.entry.size)} />
              <PropertyRow label="修改时间" value={formatFullModified(properties.entry.modifiedAt)} />
              <PropertyRow
                label="所有者"
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
                label="分组"
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
              <PropertyRow label="权限" value={formatPermissionOctal(properties.entry.permissions)} />
              <PropertyRow label="权限详情" value={formatPermissionSymbolic(properties.entry.permissions, properties.entry.kind)} />
            </div>
          </div>
        </div>
      ) : null}

      {uploadProgress ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/80 p-2 backdrop-blur-sm">
          <div className="surface flex w-full max-w-sm flex-col gap-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium tracking-[0.08em] text-cyan-300/80">{uploadProgress.cancelling ? '正在取消' : '上传中'}</span>
              <span className="text-xs font-medium text-slate-300">{uploadProgressPercent(uploadProgress)}%</span>
            </div>

            <div className="h-2 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-cyan-400 transition-[width] duration-150"
                style={{ width: `${uploadProgressPercent(uploadProgress)}%` }}
              />
            </div>

            <div className="flex flex-col gap-0.5">
              <strong className="truncate text-sm text-slate-100">
                {uploadProgress.currentPath ? localPathName(uploadProgress.currentPath) : '正在准备上传'}
              </strong>
              <span className="text-xs text-slate-400">
                {uploadProgress.totalBytes > 0
                  ? `${formatSize(uploadProgress.uploadedBytes)} / ${formatSize(uploadProgress.totalBytes)}`
                  : `${uploadProgress.completedSteps} / ${uploadProgress.totalSteps} 项`}
              </span>
            </div>

            <div className="flex justify-end">
              <button className="icon-btn" disabled={uploadProgress.cancelling} onClick={() => void handleCancelUpload()} type="button">
                {uploadProgress.cancelling ? '取消中...' : '取消上传'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteProgress ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/80 p-2 backdrop-blur-sm">
          <div className="surface flex w-full max-w-sm flex-col gap-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium tracking-[0.08em] text-cyan-300/80">删除中</span>
              <span className="text-xs font-medium text-slate-300">{stepProgressPercent(deleteProgress)}%</span>
            </div>

            <div className="h-2 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full bg-rose-400 transition-[width] duration-150"
                style={{ width: `${stepProgressPercent(deleteProgress)}%` }}
              />
            </div>

            <div className="flex flex-col gap-0.5">
              <strong className="truncate text-sm text-slate-100">
                {deleteProgress.currentPath ? localPathName(deleteProgress.currentPath) : '正在准备删除'}
              </strong>
              <span className="text-xs text-slate-400">
                {deleteProgress.completedSteps} / {deleteProgress.totalSteps} 项
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {dragActive && ready && !uploadProgress && !deleteProgress ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/80 p-2 backdrop-blur-sm">
          <div className="surface flex max-w-xs flex-col gap-1 p-3 text-center">
            <span className="text-[11px] font-medium tracking-[0.08em] text-cyan-300/80">上传</span>
            <strong className="text-[15px] font-semibold tracking-[0.01em] text-slate-100">释放鼠标以上传到当前目录</strong>
            <span className="text-xs text-slate-400">支持拖入文件或整个文件夹。</span>
          </div>
        </div>
      ) : null}

      {dialog ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/70 p-2 backdrop-blur-sm">
          <form className="surface flex w-full max-w-xs flex-col gap-2 p-3" onSubmit={(event) => void submitDialog(event)}>
            <div>
              <p className="text-[11px] font-medium tracking-[0.08em] text-cyan-300/80">{dialog.mode === 'rename' ? '重命名' : '新建'}</p>
              <h4 className="mt-1 text-[15px] font-semibold tracking-[0.01em] text-slate-100">
                {dialog.mode === 'newFile' ? '新建空文件' : dialog.mode === 'newDirectory' ? '新建文件夹' : '修改名称'}
              </h4>
            </div>

            <input
              autoFocus
              className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-[13px] leading-5 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400/60"
              onChange={(event) => setDialog((current) => (current ? { ...current, value: event.target.value } : current))}
              placeholder={dialog.mode === 'newFile' ? 'example.txt' : dialog.mode === 'newDirectory' ? '新建文件夹' : '输入新名称'}
              value={dialog.value}
            />

            <div className="flex gap-1">
              <button className="primary-btn flex-1" disabled={!dialog.value.trim() || working} type="submit">
                {dialog.mode === 'rename' ? '保存' : '确定'}
              </button>
              <button className="icon-btn" onClick={() => setDialog(undefined)} type="button">
                取消
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {pendingDelete ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/70 p-2 backdrop-blur-sm">
          <div className="surface flex w-full max-w-sm flex-col gap-2 p-3">
            <div className="flex flex-col gap-1">
              <p className="text-[11px] font-medium tracking-[0.08em] text-cyan-300/80">删除确认</p>
              <h4 className="text-[15px] font-semibold tracking-[0.01em] text-slate-100">
                {pendingDelete.kind === 'directory' ? '删除目录' : '删除文件'}
              </h4>
              <p className="text-xs text-slate-400">
                {pendingDelete.kind === 'directory' ? `确认删除“${pendingDelete.name}”及其内容吗？` : `确认删除“${pendingDelete.name}”吗？`}
              </p>
            </div>

            <div className="flex justify-end gap-1">
              <button className="icon-btn" onClick={() => setPendingDelete(undefined)} type="button">
                取消
              </button>
              <button
                className="inline-flex items-center justify-center rounded-lg bg-rose-400 px-3 py-2 text-xs font-semibold text-white transition hover:bg-rose-300"
                onClick={() => void confirmDelete()}
                type="button"
              >
                删除
              </button>
            </div>
          </div>
        </div>
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
