import { type FormEvent, type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  type CellContextMenuEvent,
  type SelectionChangedEvent,
} from 'ag-grid-community';
import { useContextMenu } from '../../hooks/useContextMenu';
import { t } from '../../lib/i18n';
import { createLogger } from '../../lib/logger';
import { addPathWrapOpportunities, cn, fileKindColor } from '../../lib/ui';
import { isTauriRuntime } from '../../lib/tauri';
import { useFileManagerStore } from '../../stores/fileManagerStore';
import { useOperationStore } from '../../stores/operationStore';
import type {
  DeleteProgressEvent,
  DownloadProgressEvent,
  RemoteDirectoryListing,
  RemoteFileContent,
  RemoteFileEntry,
  SessionState,
  UploadProgressEvent,
} from '../../types';
import { Checkbox, Input } from '@chakra-ui/react';
import { ScrollArea } from '../ScrollArea';
import { Toast, type ToastAction } from '../Toast';
import { CloseIcon, FileIcon, FolderIcon, LinkIcon, DotsIcon } from '../Icons';
import { EmptyStates, ErrorState, ReadOnlyState } from './EmptyStates';
import { FileGrid } from './FileGrid';
import { FileManagerContextMenu } from './ContextMenu';
import { OperationLog } from './OperationLog';
import { PropertiesPanel } from './PropertiesPanel';
import { PreviewPanel } from './PreviewPanel';
import { Toolbar } from './Toolbar';
import { useDragDrop } from './hooks/useDragDrop';
import { useFileOperations, type ToastState as OperationsToastState } from './hooks/useFileOperations';
import { formatSize, kindLabel } from './lib/formatters';
import type {
  ClipboardState,
  EntryDialogState,
  MenuTarget,
  PendingDeleteState,
  PendingUploadConflictState,
  PermissionEditState,
  PropertiesState,
} from './types';

interface FileManagerProps {
  session?: SessionState;
  ignoreWindowDragDrop?: boolean;
  bookmarks?: string[];
  onAddBookmark?: (path: string) => void;
  onRemoveBookmark?: (path: string) => void;
}

interface ToastState {
  action?: ToastAction;
  message: string;
  tone: 'success' | 'error' | 'info';
}

const fileManagerLogger = createLogger('file-manager');

const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_ENTRY_ARRAY: RemoteFileEntry[] = [];

function operationProgressPercent(event: { totalBytes: number; completedBytes: number; totalSteps: number; completedSteps: number }): number {
  if (event.totalBytes > 0) return Math.min(100, Math.round((event.completedBytes / event.totalBytes) * 100));
  if (event.totalSteps > 0) return Math.min(100, Math.round((event.completedSteps / event.totalSteps) * 100));
  return 0;
}

function formatOperationTotalText(event: { totalBytes: number; completedBytes: number; totalSteps: number; completedSteps: number }): string {
  if (event.totalBytes > 0) return `${formatSize(event.completedBytes)} / ${formatSize(event.totalBytes)}`;
  return t('fileManager.progress.items', { completed: event.completedSteps, total: event.totalSteps });
}

export function FileManager({ session, ignoreWindowDragDrop = false, bookmarks = [], onAddBookmark, onRemoveBookmark }: FileManagerProps) {
  const [clipboard, setClipboard] = useState<ClipboardState>();
  const [pendingDelete, setPendingDelete] = useState<PendingDeleteState>();
  const [pendingBatchDelete, setPendingBatchDelete] = useState<RemoteFileEntry[]>();
  const [pendingUploadConflict, setPendingUploadConflict] = useState<PendingUploadConflictState>();
  const [properties, setProperties] = useState<PropertiesState>();
  const [permissionEdit, setPermissionEdit] = useState<PermissionEditState>();
  const [dialog, setDialog] = useState<EntryDialogState>();
  const [preview, setPreview] = useState<RemoteFileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [toast, setToast] = useState<ToastState>();
  const [contextMenuData, setContextMenuData] = useState<{ target: MenuTarget; entry?: RemoteFileEntry } | null>(null);

  const {
    isOpen: contextMenuOpen,
    position: contextMenuPosition,
    open: openContextMenu,
    close: closeContextMenu,
    menuRef: contextMenuRef,
  } = useContextMenu('file-manager');

  const sessionId = session?.sessionId;
  const listing = useFileManagerStore((state) =>
    sessionId ? state.sessions[sessionId]?.listing : undefined,
  );
  const pathInput = useFileManagerStore((state) => (sessionId ? state.sessions[sessionId]?.pathInput ?? '' : ''));
  const selectedPath = useFileManagerStore((state) => (sessionId ? state.sessions[sessionId]?.selectedPath : undefined));
  const selectedPaths = useFileManagerStore((state) =>
    sessionId ? state.sessions[sessionId]?.selectedPaths ?? EMPTY_STRING_ARRAY : EMPTY_STRING_ARRAY,
  );
  const error = useFileManagerStore((state) => (sessionId ? state.sessions[sessionId]?.error : undefined));
  const viewMode = useFileManagerStore((state) => (sessionId ? state.sessions[sessionId]?.viewMode ?? 'list' : 'list'));
  const updateSessionState = useFileManagerStore((state) => state.updateSessionState);
  const startOperation = useOperationStore((state) => state.startOperation);
  const updateOperation = useOperationStore((state) => state.updateOperation);
  const setOperationStatus = useOperationStore((state) => state.setOperationStatus);
  const setCancelling = useOperationStore((state) => state.setCancelling);

  const connection = useMemo(() => {
    if (!session) return undefined;
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

  const selectedEntry = useMemo(() => listing?.entries.find((entry) => entry.path === selectedPath), [listing, selectedPath]);
  const selectedEntries = useMemo(() => listing?.entries.filter((entry) => selectedPaths.includes(entry.path)) ?? EMPTY_ENTRY_ARRAY, [listing, selectedPaths]);
  const filteredEntries = useMemo(() => {
    if (!listing || !filterQuery.trim()) return listing?.entries ?? EMPTY_ENTRY_ARRAY;
    const query = filterQuery.toLowerCase();
    return listing.entries.filter((entry) => entry.name.toLowerCase().includes(query));
  }, [listing, filterQuery]);
  const ready = !!session && session.status === 'connected' && !!connection;
  const readOnly = !!session && session.status !== 'connected';
  const currentPath = listing?.path;
  const isCurrentPathBookmarked = useMemo(() => {
    if (!currentPath) return false;
    return bookmarks.includes(currentPath);
  }, [currentPath, bookmarks]);

  const setPathInput = (value: string) => {
    if (!sessionId) return;
    updateSessionState(sessionId, { pathInput: value });
  };

  const setSelectedPath = (value?: string) => {
    if (!sessionId) return;
    updateSessionState(sessionId, { selectedPath: value });
  };

  const setSelectedPaths = (value: string[]) => {
    if (!sessionId) return;
    updateSessionState(sessionId, { selectedPaths: value });
  };

  const setFileError = (value?: string) => {
    if (!sessionId) return;
    updateSessionState(sessionId, { error: value });
  };

  const setToastWrapper = (value?: OperationsToastState) => {
    setToast(value);
  };

  const operations = useFileOperations({
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
    setToast: setToastWrapper,
    setDialog,
    setProperties,
    setPermissionEdit,
    setPreview,
    setClipboard,
    setPendingUploadConflict,
    setPendingDelete,
    setPendingBatchDelete,
    setSelectedPath,
    setSelectedPaths,
    closeContextMenu,
  });

  const { dragActive, setDragActive } = useDragDrop({
    ready,
    currentPath,
    ignoreWindowDragDrop,
    loading,
    working,
    onUpload: operations.uploadPaths,
  });

  useEffect(() => {
    return () => {
      operations.uploadConflictResolverRef.current?.('cancel', false);
      operations.uploadConflictResolverRef.current = null;
    };
  }, [operations.uploadConflictResolverRef]);

  useEffect(() => {
    setClipboard(undefined);
    setPendingDelete(undefined);
    setPendingBatchDelete(undefined);
    setProperties(undefined);
    setPermissionEdit(undefined);
    setDialog(undefined);
    closeContextMenu();
    setToast(undefined);
    setDragActive(false);
    setFilterQuery('');

    if (!ready) return;
    if (listing) return;
    void operations.loadDirectory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sessionId, listing]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let dispose: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      const unlisten = await listen<UploadProgressEvent>('upload-progress', (event) => {
        const operationId = event.payload.operationId;
        const targetSessionId = operations.uploadSessionByOperationRef.current[operationId];
        if (!targetSessionId) return;
        updateOperation(operationId, {
          progress: operationProgressPercent({
            totalBytes: event.payload.totalBytes,
            completedBytes: event.payload.uploadedBytes,
            totalSteps: event.payload.totalSteps,
            completedSteps: event.payload.completedSteps,
          }),
          totalText: formatOperationTotalText({
            totalBytes: event.payload.totalBytes,
            completedBytes: event.payload.uploadedBytes,
            totalSteps: event.payload.totalSteps,
            completedSteps: event.payload.completedSteps,
          }),
        });
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
  }, [updateOperation]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let dispose: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      const unlisten = await listen<DeleteProgressEvent>('delete-progress', (event) => {
        updateOperation(event.payload.operationId, {
          progress: operationProgressPercent({
            totalBytes: 0,
            completedBytes: 0,
            totalSteps: event.payload.totalSteps,
            completedSteps: event.payload.completedSteps,
          }),
          totalText: formatOperationTotalText({
            totalBytes: 0,
            completedBytes: 0,
            totalSteps: event.payload.totalSteps,
            completedSteps: event.payload.completedSteps,
          }),
        });
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
  }, [updateOperation]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let dispose: UnlistenFn | undefined;
    let cancelled = false;

    const attach = async () => {
      const unlisten = await listen<DownloadProgressEvent>('download-progress', (event) => {
        updateOperation(event.payload.operationId, {
          progress: operationProgressPercent({
            totalBytes: event.payload.totalBytes,
            completedBytes: event.payload.downloadedBytes,
            totalSteps: event.payload.totalSteps,
            completedSteps: event.payload.completedSteps,
          }),
          totalText: formatOperationTotalText({
            totalBytes: event.payload.totalBytes,
            completedBytes: event.payload.downloadedBytes,
            totalSteps: event.payload.totalSteps,
            completedSteps: event.payload.completedSteps,
          }),
        });
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
  }, [updateOperation]);

  const openCreateDialog = (mode: 'newFile' | 'newDirectory') => {
    if (!ready) return;
    setDialog({ mode, value: '' });
    closeContextMenu();
  };

  const handleSelectUploadFiles = async () => {
    if (!ready || !currentPath || loading || working) return;
    closeContextMenu();
    try {
      const selectedPaths = await invoke<string[]>('pick_local_files');
      await operations.uploadPaths(selectedPaths);
    } catch (nextError) {
      setToast({ message: String(nextError), tone: 'error' });
    }
  };

  const handleSelectUploadFolder = async () => {
    if (!ready || !currentPath || loading || working) return;
    closeContextMenu();
    try {
      const selectedPaths = await invoke<string[]>('pick_local_folder', { title: t('fileManager.dialog.uploadFolder') });
      await operations.uploadPaths(selectedPaths);
    } catch (nextError) {
      setToast({ message: String(nextError), tone: 'error' });
    }
  };

  const openBlankMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!ready) return;
    event.preventDefault();
    event.stopPropagation();
    setContextMenuData({ target: 'blank' });
    openContextMenu(event.clientX, event.clientY);
  };

  const handleGridContextMenu = (event: CellContextMenuEvent<RemoteFileEntry>) => {
    if (!ready) return;
    const target = event.data;
    const mouseEvent = event.event as MouseEvent | undefined;
    if (!target || !mouseEvent) return;

    mouseEvent.preventDefault();
    mouseEvent.stopPropagation();
    setSelectedPath(target.path);
    if (event.node) event.node.setSelected(true, true);
    setContextMenuData({ target: 'entry', entry: target });
    openContextMenu(mouseEvent.clientX, mouseEvent.clientY);
  };

  const handleGridSelectionChanged = (event: SelectionChangedEvent<RemoteFileEntry>) => {
    const paths = event.api.getSelectedRows().map((row) => row.path);
    setSelectedPaths(paths);
    if (paths.length === 1) setSelectedPath(paths[0]);
  };

  const handleGridRowClick = (entry: RemoteFileEntry) => {
    setSelectedPath(entry.path);
  };

  const handleGridRowDoubleClick = (entry: RemoteFileEntry) => {
    if (entry.kind === 'directory') void operations.loadDirectory(entry.path);
  };

  const handlePermissionInputChange = (value: string) => {
    setPermissionEdit((current) => (current ? { ...current, value } : current));
  };

  const handleSubmitDialog = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dialog) return;
    await operations.submitDialog(dialog, selectedEntry);
  };

  const handleCopyCurrentDirectoryPath = () => {
    if (currentPath) void operations.handleCopyText(t('fileManager.copyLabel.currentDirectoryPath'), currentPath);
  };

  const handleCopyContainingDirectory = (entry?: RemoteFileEntry) => {
    const value = entry ? (entry.kind === 'directory' ? entry.path : entry.path.split('/').slice(0, -1).join('/') || '/') : (currentPath ?? '');
    void operations.handleCopyText(t('fileManager.copyLabel.directoryPath'), value);
  };

  const handleBatchCopy = () => {
    if (!selectedEntry) return;
    operations.copyEntry(selectedEntry);
  };

  const hasLoadedAnyListingRef = useRef(false);
  useEffect(() => {
    if (listing) hasLoadedAnyListingRef.current = true;
  }, [listing]);

  return (
    <aside className="surface relative flex min-h-0 flex-col overflow-hidden font-['PingFang_SC','Hiragino_Sans_GB','Microsoft_YaHei_UI','Noto_Sans_SC','Source_Han_Sans_SC',sans-serif]">
      <div className="surface-header">
        <div className="min-w-0">
          <p className="label">{t('fileManager.subtitle')}</p>
          <h3 className="themed-heading truncate text-[13px] font-semibold tracking-[0.01em]">
            {session ? t('fileManager.title.active') : t('fileManager.title.inactive')}
          </h3>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        {!session || (loading && !listing && !hasLoadedAnyListingRef.current) || (error && !listing) || (listing && listing.entries.length === 0 && !loading) ? (
          <EmptyStates
            session={session}
            loading={loading && !hasLoadedAnyListingRef.current}
            listing={listing}
            error={error}
            readOnly={readOnly && !!listing && listing.entries.length === 0}
            onRetry={() => void operations.loadDirectory(currentPath)}
            onNewFile={() => openCreateDialog('newFile')}
            onNewFolder={() => openCreateDialog('newDirectory')}
            onUpload={handleSelectUploadFiles}
          />
        ) : (
          <>
            <Toolbar
              ready={ready}
              readOnly={readOnly}
              loading={loading}
              working={working}
              currentPath={currentPath}
              filterQuery={filterQuery}
              viewMode={viewMode}
              selectedCount={selectedPaths.length}
              onNavigate={(path) => void operations.loadDirectory(path)}
              onCopyPath={handleCopyCurrentDirectoryPath}
              onRefresh={() => void operations.loadDirectory(currentPath)}
              onNewFile={() => openCreateDialog('newFile')}
              onNewFolder={() => openCreateDialog('newDirectory')}
              onUploadFile={handleSelectUploadFiles}
              onUploadFolder={handleSelectUploadFolder}
              onDownload={() => void operations.downloadEntry()}
              onFilterChange={setFilterQuery}
              onViewModeChange={(mode) => {
                if (sessionId) updateSessionState(sessionId, { viewMode: mode });
              }}
              onBatchDownload={() => void operations.batchDownload(selectedEntries)}
              onBatchDelete={() => operations.batchDelete(selectedEntries)}
              onBatchCopy={handleBatchCopy}
              onClearSelection={() => {
                setSelectedPaths([]);
                setSelectedPath(undefined);
              }}
            />
            {error ? <ErrorState error={error} onRetry={() => void operations.loadDirectory(currentPath)} /> : null}
            {readOnly && listing ? <ReadOnlyState /> : null}
            <FileGrid
              loading={loading}
              listing={listing}
              filteredEntries={filteredEntries}
              selectedPaths={selectedPaths}
              onRowClick={handleGridRowClick}
              onRowDoubleClick={handleGridRowDoubleClick}
              onContextMenu={handleGridContextMenu}
              onSelectionChanged={handleGridSelectionChanged}
              onBlankContextMenu={openBlankMenu}
              onClearSelection={() => {
                setSelectedPaths([]);
                setSelectedPath(undefined);
              }}
            />
          </>
        )}
      </div>

      <OperationLog sessionId={sessionId} />

      {contextMenuOpen && contextMenuData && contextMenuPosition
        ? createPortal(
            <div
              className="themed-menu fixed z-50 min-w-44 rounded-[4px] p-1 backdrop-blur"
              onClick={(event) => event.stopPropagation()}
              onContextMenu={(event) => event.preventDefault()}
              onMouseDown={(event) => {
                if (event.button === 2) event.preventDefault();
              }}
              ref={contextMenuRef}
              style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
            >
              <FileManagerContextMenu
                target={contextMenuData.target}
                entry={contextMenuData.entry}
                ready={ready}
                readOnly={readOnly}
                loading={loading}
                working={working}
                bookmarks={bookmarks}
                isCurrentPathBookmarked={isCurrentPathBookmarked}
                clipboard={clipboard}
                currentPath={currentPath}
                onOpen={(entry) => {
                  if (entry?.kind === 'directory') void operations.loadDirectory(entry.path);
                }}
                onOpenWithDefaultEditor={operations.openWithDefaultEditor}
                onPreview={operations.previewFile}
                onDownload={operations.downloadEntry}
                onCopy={operations.copyEntry}
                onRename={operations.openRenameDialog}
                onDelete={operations.deleteEntry}
                onCopyName={(entry) => {
                  if (entry) void operations.handleCopyText(t('fileManager.copyLabel.name'), entry.name);
                }}
                onCopyPath={(entry) => {
                  if (entry) void operations.handleCopyText(t('fileManager.copyLabel.filePath'), entry.path);
                }}
                onCopyContainingDirectory={handleCopyContainingDirectory}
                onPaste={() => void operations.paste(clipboard)}
                onCopyCurrentDirectoryPath={handleCopyCurrentDirectoryPath}
                onRefresh={() => void operations.loadDirectory(currentPath)}
                onAddBookmark={(path) => onAddBookmark?.(path)}
                onRemoveBookmark={(path) => onRemoveBookmark?.(path)}
                onNewFile={() => openCreateDialog('newFile')}
                onNewFolder={() => openCreateDialog('newDirectory')}
                onUploadFile={handleSelectUploadFiles}
                onUploadFolder={handleSelectUploadFolder}
                onProperties={operations.openProperties}
                onPermissionEdit={operations.openPermissionEdit}
              />
            </div>,
            document.body,
          )
        : null}

      {preview ? (
        <PreviewPanel
          preview={preview}
          onClose={() => setPreview(null)}
          onCopyContent={() => {
            if (preview?.isText) void operations.handleCopyText(t('fileManager.preview.copy'), preview.content);
          }}
        />
      ) : null}

      {properties ? (
        <PropertiesPanel
          properties={properties}
          permissionEdit={permissionEdit}
          working={working}
          ready={ready}
          onClose={() => {
            setProperties(undefined);
            setPermissionEdit(undefined);
          }}
          onPermissionEdit={operations.openPermissionEdit}
          onPermissionChange={handlePermissionInputChange}
          onPermissionCancel={() => setPermissionEdit(undefined)}
          onPermissionSave={() => {
            if (permissionEdit) void operations.updatePermissions(permissionEdit);
          }}
        />
      ) : null}

      {dragActive && ready ? (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center p-2 backdrop-blur-sm"
          style={{ background: 'var(--app-overlay)' }}
        >
          <div className="surface flex w-full max-w-xs flex-col gap-1 rounded-[4px] p-3 text-center">
            <span className="text-[11px] font-medium tracking-[0.08em] text-[var(--fm-text-soft)]">{t('fileManager.dragDrop.title')}</span>
            <strong className="text-[15px] font-semibold tracking-[0.01em] text-[var(--fm-text)]">{t('fileManager.dragDrop.description')}</strong>
            <span className="text-xs text-[var(--fm-text-muted)]">{t('fileManager.dragDrop.hint')}</span>
          </div>
        </div>
      ) : null}

      {dialog ? (
        <div className="absolute inset-0 z-20 grid place-items-center p-2 backdrop-blur-[14px]" style={{ background: 'var(--app-overlay)' }}>
          <form className="surface flex w-full max-w-xs flex-col gap-2 rounded-[4px] p-3" onSubmit={handleSubmitDialog}>
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
            <Input
              autoFocus
              className="themed-input px-3 py-2 text-[13px] leading-5"
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
              <button className="btn-cancel" onClick={() => setDialog(undefined)} type="button">
                {t('fileManager.dialog.cancel')}
              </button>
              <button className="btn-primary" disabled={!dialog.value.trim() || working} type="submit">
                {dialog.mode === 'rename' ? t('fileManager.dialog.save') : t('fileManager.dialog.confirm')}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {pendingUploadConflict ? (
        <div className="absolute inset-0 z-20 grid place-items-center p-2 backdrop-blur-[14px]" style={{ background: 'var(--app-overlay)' }}>
          <div className="surface flex w-full max-w-sm flex-col gap-2 rounded-[4px] p-3" role="dialog" aria-modal="true" aria-label={t('fileManager.uploadConflict.kicker')}>
            <div className="flex flex-col gap-1">
              <p className="dialog-kicker text-[11px] font-medium tracking-[0.08em]">{t('fileManager.uploadConflict.kicker')}</p>
              <h4 className="dialog-title text-[15px] font-semibold tracking-[0.01em]">{t('fileManager.uploadConflict.title', { name: pendingUploadConflict.conflict.targetName })}</h4>
              <p className="dialog-description text-xs leading-5">{t('fileManager.uploadConflict.description', { kind: kindLabel(pendingUploadConflict.conflict.existingKind) })}</p>
              <p className="themed-property-row break-all px-2 py-2 text-[11px] leading-5" title={pendingUploadConflict.conflict.localPath}>
                {t('fileManager.uploadConflict.source', { path: addPathWrapOpportunities(pendingUploadConflict.conflict.localPath) })}
              </p>
            </div>

            <Checkbox.Root
              className="themed-checkbox-row flex cursor-pointer items-center gap-2 px-2 py-2 text-[12px]"
              checked={pendingUploadConflict.applyToRemaining}
              size="sm"
              onCheckedChange={(details) =>
                setPendingUploadConflict((current) =>
                  current ? { ...current, applyToRemaining: details.checked as boolean } : current,
                )
              }
            >
              <Checkbox.Control className="themed-checkbox shrink-0" />
              <Checkbox.HiddenInput />
              <Checkbox.Label>
                {t('fileManager.uploadConflict.applyRemaining') +
                  (pendingUploadConflict.remainingConflicts > 0
                    ? t('fileManager.uploadConflict.remaining', { count: pendingUploadConflict.remainingConflicts })
                    : '')}
              </Checkbox.Label>
            </Checkbox.Root>

            <div className="flex justify-end gap-1">
              <button
                className="btn-cancel"
                onClick={() => {
                  operations.uploadConflictResolverRef.current?.('cancel', pendingUploadConflict.applyToRemaining);
                  setPendingUploadConflict(undefined);
                }}
                type="button"
              >
                {t('fileManager.uploadConflict.cancel')}
              </button>
              <button
                className="btn-cancel"
                onClick={() => {
                  operations.uploadConflictResolverRef.current?.('skip', pendingUploadConflict.applyToRemaining);
                  setPendingUploadConflict(undefined);
                }}
                type="button"
              >
                {t('fileManager.uploadConflict.skip')}
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  operations.uploadConflictResolverRef.current?.('overwrite', pendingUploadConflict.applyToRemaining);
                  setPendingUploadConflict(undefined);
                }}
                type="button"
              >
                {t('fileManager.uploadConflict.overwrite')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingDelete ? (
        <div className="absolute inset-0 z-20 grid place-items-center p-2 backdrop-blur-[14px]" style={{ background: 'var(--app-overlay)' }}>
          <div className="surface flex w-full max-w-sm flex-col gap-2 rounded-[4px] p-3" role="dialog" aria-modal="true" aria-label={t('fileManager.deleteConfirm.kicker')}>
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
              <button className="btn-cancel" onClick={() => setPendingDelete(undefined)} type="button">
                {t('fileManager.dialog.cancel')}
              </button>
              <button className="btn-danger" onClick={() => void operations.confirmDelete(pendingDelete)} type="button">
                {t('fileManager.deleteConfirm.confirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingBatchDelete?.length ? (
        <div className="absolute inset-0 z-20 grid place-items-center p-2 backdrop-blur-[14px]" style={{ background: 'var(--app-overlay)' }}>
          <div className="surface flex w-full max-w-sm flex-col gap-2 rounded-[4px] p-3" role="dialog" aria-modal="true" aria-label={t('fileManager.deleteConfirm.kicker')}>
            <div className="flex flex-col gap-1">
              <p className="dialog-kicker text-[11px] font-medium tracking-[0.08em]">{t('fileManager.deleteConfirm.kicker')}</p>
              <h4 className="dialog-title text-[15px] font-semibold tracking-[0.01em]">{t('fileManager.batch.deleteTitle', { count: pendingBatchDelete.length })}</h4>
              <p className="dialog-description text-xs leading-5">{t('fileManager.batch.deleteDescription', { count: pendingBatchDelete.length })}</p>
              <ScrollArea className="max-h-32">
                {pendingBatchDelete.map((entry) => (
                  <div key={entry.path} className="flex items-center gap-1.5 px-2 py-1 text-[12px]">
                    <span className={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center', fileKindColor(entry.kind))}>
                      {entry.kind === 'directory' ? <FolderIcon /> : entry.kind === 'symlink' ? <LinkIcon /> : entry.kind === 'other' ? <DotsIcon /> : <FileIcon />}
                    </span>
                    <span className="truncate">{entry.name}</span>
                  </div>
                ))}
              </ScrollArea>
            </div>
            <div className="flex justify-end gap-1">
              <button className="btn-cancel" onClick={() => setPendingBatchDelete(undefined)} type="button">
                {t('fileManager.dialog.cancel')}
              </button>
              <button className="btn-danger" onClick={() => void operations.confirmBatchDelete(pendingBatchDelete)} type="button">
                {t('fileManager.deleteConfirm.confirm')}
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
            setClipboard(undefined);
            setToast(undefined);
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
