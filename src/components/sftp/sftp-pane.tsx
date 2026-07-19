import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDndContext, useDroppable } from '@dnd-kit/core';
import { BookmarkIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsUpDownIcon, MoveDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/empty-state';
import { PathBreadcrumb } from './path-breadcrumb';
import { SftpFileList } from './sftp-file-list';
import { SftpFileContextMenu, type SftpFileContextMenuAction } from './sftp-file-context-menu';
import { SftpBlankContextMenu, type SftpBlankContextMenuAction } from './sftp-blank-context-menu';
import { SftpBookmarkMenu } from './sftp-bookmark-menu';
import { useLocalDirectory } from '@/hooks/useLocalDirectory';
import { useSftpConnection } from '@/hooks/useSftpConnection';
import {
  getSftpPaneConnectionKey,
  type SftpConnection,
  type SftpSide,
} from '@/stores/sftpStore';
import { useSftpPaneActions, type UseSftpPaneActionsResult } from '@/hooks/useSftpPaneActions';
import type { FileEntry } from './file-entry-formatters';
import type { SftpDndPayload } from './sftp-dnd-context';
import { parentPortablePath } from '@/lib/path-utils';
import { hasActivePathOperation, useTransferStore } from '@/stores/transferStore';

export interface SftpPaneProps {
  connection: SftpConnection;
  side: SftpSide;
  actions: UseSftpPaneActionsResult;
  selectedPaths: Set<string>;
  onSelectedPathsChange: (paths: Set<string>) => void;
  onVerifyHostKey?: () => void;
  systemDropActive?: boolean;
  systemDropHovered?: boolean;
  localMode?: boolean;
  onTitleClick?: () => void;
}

interface HistoryState {
  stack: string[];
  index: number;
}

export const SftpPane = React.forwardRef<HTMLDivElement, SftpPaneProps>((
  {
    connection,
    side,
    actions,
    selectedPaths,
    onSelectedPathsChange,
    onVerifyHostKey,
    systemDropActive,
    systemDropHovered,
    localMode,
    onTitleClick,
  },
  ref,
) => {
  const { t } = useI18n();
  const { active } = useDndContext();
  const { setNodeRef, isOver } = useDroppable({
    id: `sftp-pane-${side}-${connection.id}`,
    data: { side },
  });

  const mergedRef = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    },
    [setNodeRef, ref],
  );

  const isLocal = localMode ?? side === 'local';
  const activeDrag = active?.data.current as SftpDndPayload | undefined;
  const canAcceptActiveDrag = !!activeDrag && activeDrag.side !== side;
  const path = side === 'local' ? connection.localPath : connection.remotePath;
  const entries = side === 'local' ? connection.localEntries : connection.remoteEntries;
  const loading = side === 'local' ? connection.localLoading : connection.remoteLoading;
  const error = side === 'local' ? connection.localError : connection.remoteError;
  const isHostKeyError =
    !isLocal &&
    !!error &&
    (error.toLowerCase().includes('host key') ||
      error.toLowerCase().includes('trust this host'));
  const pane = side === 'local' ? connection.localPane : connection.remotePane;
  const remoteBookmarks = connection.remoteBookmarks[side];

  const { loadLocalDirectory } = useLocalDirectory(connection, side);
  const { loadRemoteDirectory } = useSftpConnection(connection, side);

  const [history, setHistory] = useState<HistoryState>({
    stack: [path],
    index: 0,
  });
  const [fileContextMenu, setFileContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry;
  } | null>(null);
  const [blankContextMenu, setBlankContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [bookmarkMenu, setBookmarkMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (isLocal) {
      loadLocalDirectory('');
    } else {
      loadRemoteDirectory('');
    }
  }, [isLocal, loadLocalDirectory, loadRemoteDirectory]);

  const navigateTo = useCallback(
    (target: string, pushHistory = true): void => {
      if (isLocal) {
        loadLocalDirectory(target);
      } else {
        loadRemoteDirectory(target);
      }
      onSelectedPathsChange(new Set());

      if (pushHistory) {
        setHistory((prev) => {
          const stack = prev.stack.slice(0, prev.index + 1);
          if (stack[stack.length - 1] === target) return prev;
          return { stack: [...stack, target], index: stack.length };
        });
      }
    },
    [isLocal, loadLocalDirectory, loadRemoteDirectory, onSelectedPathsChange],
  );

  const goBack = useCallback((): void => {
    setHistory((prev) => {
      if (prev.index <= 0) return prev;
      const nextIndex = prev.index - 1;
      navigateTo(prev.stack[nextIndex], false);
      return { ...prev, index: nextIndex };
    });
  }, [navigateTo]);

  const goForward = useCallback((): void => {
    setHistory((prev) => {
      if (prev.index >= prev.stack.length - 1) return prev;
      const nextIndex = prev.index + 1;
      navigateTo(prev.stack[nextIndex], false);
      return { ...prev, index: nextIndex };
    });
  }, [navigateTo]);

  const handleParentDirectory = useCallback((): void => {
    navigateTo(parentPortablePath(path));
  }, [path, navigateTo]);

  const handleSelect = useCallback(
    (paths: string[]): void => {
      onSelectedPathsChange(new Set(paths));
    },
    [onSelectedPathsChange],
  );

  const handleDoubleClick = useCallback(
    (entry: FileEntry): void => {
      if (entry.kind === 'directory') {
        navigateTo(entry.path);
      }
    },
    [navigateTo],
  );

  const handleFileContextMenu = useCallback(
    (entry: FileEntry, e: React.MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (!selectedPaths.has(entry.path)) {
        onSelectedPathsChange(pane.batchMode ? new Set([...selectedPaths, entry.path]) : new Set([entry.path]));
      }
      setBlankContextMenu(null);
      setBookmarkMenu(null);
      setFileContextMenu({ x: e.clientX, y: e.clientY, entry });
    },
    [onSelectedPathsChange, pane.batchMode, selectedPaths],
  );

  const handleBlankContextMenu = useCallback((e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    setFileContextMenu(null);
    setBookmarkMenu(null);
    setBlankContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const paneTitle = isLocal
    ? t('sftp.local')
    : side === 'local'
      ? connection.leftTitle ?? connection.title
      : connection.title;

  const selectedEntries = useMemo(() => entries.filter((entry) => selectedPaths.has(entry.path)), [entries, selectedPaths]);
  const transferOperations = useTransferStore((state) => state.operations);
  const selectionBusy = !isLocal && hasActivePathOperation(
    getSftpPaneConnectionKey(connection, side),
    selectedEntries.map((entry) => entry.path),
    transferOperations,
  );
  const singleSelection = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
  const isCurrentPathBookmarked = path ? remoteBookmarks.includes(path) : false;

  const handleSelectAll = useCallback((): void => {
    onSelectedPathsChange(new Set(entries.map((entry) => entry.path)));
  }, [entries, onSelectedPathsChange]);

  const handleExitBatchMode = useCallback((): void => {
    actions.onToggleBatchMode();
  }, [actions]);

  useEffect(() => {
    if (!pane.batchMode || fileContextMenu || blankContextMenu || bookmarkMenu) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        handleExitBatchMode();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [blankContextMenu, bookmarkMenu, fileContextMenu, handleExitBatchMode, pane.batchMode]);

  const handleFileContextMenuAction = useCallback(
    (action: SftpFileContextMenuAction): void => {
      switch (action) {
        case 'open':
          actions.onOpen(selectedEntries[0]!);
          break;
        case 'openWithDefaultEditor':
          void actions.onOpenWithDefaultEditor(singleSelection);
          break;
        case 'preview':
          void actions.onPreview(singleSelection);
          break;
        case 'download':
          void actions.onDownload(singleSelection);
          break;
        case 'batchMode':
          actions.onToggleBatchMode();
          break;
        case 'rename':
          actions.onRename(singleSelection);
          break;
        case 'copy':
          actions.onCopy(singleSelection);
          break;
        case 'delete':
          void actions.onDelete(selectedEntries);
          break;
        case 'copyName':
          void actions.onCopyName(singleSelection);
          break;
        case 'copyPath':
          void actions.onCopyPath(singleSelection);
          break;
        case 'copyContainingDirectory':
          void actions.onCopyContainingDirectory(singleSelection);
          break;
        case 'newFile':
          actions.onNewFile();
          break;
        case 'newFolder':
          actions.onNewFolder();
          break;
        case 'uploadFile':
          void actions.onUploadFiles();
          break;
        case 'uploadFolder':
          void actions.onUploadFolders();
          break;
        case 'editPermissions':
          actions.onEditPermissions(singleSelection);
          break;
        case 'properties':
          actions.onProperties(singleSelection);
          break;
        case 'bookmark':
          actions.onToggleBookmark(singleSelection?.path);
          break;
        case 'refresh':
          void actions.onRefresh();
          break;
      }
    },
    [actions, selectedEntries, singleSelection],
  );

  const handleBlankContextMenuAction = useCallback(
    (action: SftpBlankContextMenuAction): void => {
      switch (action) {
        case 'newFile':
          actions.onNewFile();
          break;
        case 'newFolder':
          actions.onNewFolder();
          break;
        case 'uploadFile':
          void actions.onUploadFiles();
          break;
        case 'uploadFolder':
          void actions.onUploadFolders();
          break;
        case 'paste':
          void actions.onPaste();
          break;
        case 'copyCurrentDirectoryPath':
          void actions.onCopyCurrentDirectoryPath();
          break;
        case 'batchMode':
          actions.onToggleBatchMode();
          break;
        case 'refresh':
          void actions.onRefresh();
          break;
        case 'bookmark':
          actions.onToggleBookmark(path);
          break;
      }
    },
    [actions, path],
  );

  const handleBookmarkButtonClick = useCallback((e: React.MouseEvent<HTMLButtonElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    setFileContextMenu(null);
    setBlankContextMenu(null);
    setBookmarkMenu({ x: rect.left, y: rect.bottom + 4 });
  }, []);

  const handleBookmarkNavigate = useCallback(
    (target: string) => {
      navigateTo(target);
    },
    [navigateTo],
  );

  const canGoBack = history.index > 0;
  const canGoForward = history.index < history.stack.length - 1;

  return (
    <div ref={mergedRef} className="flex h-full flex-col overflow-hidden bg-app-surface">
      {/* Title bar */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-app-border bg-app-surface px-3">
        {onTitleClick ? (
          <Button
            variant="ghost"
            size="xs"
            onClick={onTitleClick}
            aria-label={t('sftp.source.switch')}
            className="min-w-0 max-w-[70%] justify-start px-1"
          >
            <span className="truncate text-sm font-semibold">{paneTitle}</span>
            <ChevronsUpDownIcon data-icon="inline-end" />
          </Button>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-app-text">{paneTitle}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          {!isLocal && remoteBookmarks.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleBookmarkButtonClick}
              className="gap-1.5 px-2"
              aria-label={t('sftp.contextMenu.bookmark.add')}
            >
              <BookmarkIcon className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Navigation row */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-app-border bg-app-surface-muted px-1">
        <div className="flex items-center">
          <Button variant="ghost" size="icon" onClick={goBack} disabled={!canGoBack} className="h-6 w-6">
            <ChevronLeftIcon className={cn('h-4 w-4', !canGoBack && 'opacity-30')} />
          </Button>
          <Button variant="ghost" size="icon" onClick={goForward} disabled={!canGoForward} className="h-6 w-6">
            <ChevronRightIcon className={cn('h-4 w-4', !canGoForward && 'opacity-30')} />
          </Button>
        </div>

        <PathBreadcrumb
          path={path}
          onNavigate={navigateTo}
          normalizeInputPath={isLocal}
          className="flex-1"
        />
      </div>

      {/* File list */}
      <div className="relative flex-1 min-h-0">
        {canAcceptActiveDrag && isOver && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-app-primary/70 bg-app-surface/70 p-6">
            <div className="flex flex-col items-center gap-2 px-5 py-4 text-center text-app-text">
              <MoveDownIcon aria-hidden="true" className="size-8 text-app-primary" />
              <span className="text-sm font-semibold">{t('sftp.dropHint')}</span>
            </div>
          </div>
        )}
        {systemDropActive && systemDropHovered && (
          <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center border-2 border-dashed border-app-primary/70 bg-app-surface/70 p-6">
            <div className="flex flex-col items-center gap-2 px-5 py-4 text-center text-app-text">
              <MoveDownIcon aria-hidden="true" className="size-8 text-app-primary" />
              <span className="text-sm font-semibold">{t('sftp.dropHint')}</span>
            </div>
          </div>
        )}
        {loading && entries.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-app-surface">
            <Spinner />
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-app-surface p-4 text-center text-xs text-app-error">
            <span>{error}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={
                isHostKeyError && onVerifyHostKey
                  ? onVerifyHostKey
                  : () => navigateTo(path)
              }
            >
              {isHostKeyError
                ? t('sftp.hostKey.verify')
                : t('common.retry')}
            </Button>
          </div>
        )}
        {pane.batchMode && (
          <div className="absolute bottom-3 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-lg border border-app-border bg-app-surface px-2 py-1.5 shadow-[var(--shadow-dialog)]">
            <span className="whitespace-nowrap px-1 text-xs font-medium text-app-text">
              {t('sftp.selection.selectedCount', {
                count: selectedEntries.length,
              })}
            </span>
            <span className="mx-1 h-4 w-px shrink-0 bg-app-border" />
            <Button variant="ghost" size="xs" onClick={handleSelectAll}>
              {t('sftp.selection.selectAll')}
            </Button>
            <Button variant="ghost" size="xs" onClick={handleExitBatchMode}>
              {t('common.cancel')}
            </Button>
            {!isLocal && (
              <>
                <Button variant="default" size="xs" onClick={() => void actions.onBatchDownload()} disabled={selectedEntries.length === 0 || selectionBusy}>
                  {t('common.download')}
                </Button>
                <Button
                  variant="destructive"
                  size="xs"
                  onClick={() => void actions.onDelete(selectedEntries)}
                  disabled={selectedEntries.length === 0 || selectionBusy}
                >
                  {t('common.delete')}
                </Button>
              </>
            )}
          </div>
        )}
        {!error && (
          <SftpFileList
            entries={entries}
            side={side}
            localMode={isLocal}
            selectedPaths={Array.from(selectedPaths)}
            filterQuery=""
            batchMode={pane.batchMode}
            currentPath={path}
            onSelect={handleSelect}
            onDoubleClick={handleDoubleClick}
            onContextMenu={handleFileContextMenu}
            onBlankContextMenu={handleBlankContextMenu}
            onParentDirectory={handleParentDirectory}
          />
        )}
      </div>

      <SftpFileContextMenu
        open={!!fileContextMenu}
        x={fileContextMenu?.x ?? 0}
        y={fileContextMenu?.y ?? 0}
        side={side}
        local={isLocal}
        currentPath={path}
        selectedEntries={selectedEntries}
        isBookmarked={singleSelection ? remoteBookmarks.includes(singleSelection.path) : false}
        batchMode={pane.batchMode}
        selectionBusy={selectionBusy}
        onClose={() => setFileContextMenu(null)}
        onAction={handleFileContextMenuAction}
      />

      <SftpBlankContextMenu
        open={!!blankContextMenu}
        x={blankContextMenu?.x ?? 0}
        y={blankContextMenu?.y ?? 0}
        side={side}
        local={isLocal}
        currentPath={path}
        hasClipboard={!!connection.remoteClipboard}
        isBookmarked={isCurrentPathBookmarked}
        batchMode={pane.batchMode}
        onClose={() => setBlankContextMenu(null)}
        onAction={handleBlankContextMenuAction}
      />

      <SftpBookmarkMenu
        open={!!bookmarkMenu}
        x={bookmarkMenu?.x ?? 0}
        y={bookmarkMenu?.y ?? 0}
        bookmarks={remoteBookmarks}
        onNavigate={handleBookmarkNavigate}
        onClose={() => setBookmarkMenu(null)}
      />
    </div>
  );
});
SftpPane.displayName = 'SftpPane';
