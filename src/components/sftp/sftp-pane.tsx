import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDndContext, useDroppable } from '@dnd-kit/core';
import { BookmarkIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsUpDownIcon, MoveDownIcon, SearchIcon, SquareTerminalIcon } from 'lucide-react';
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
import { getSftpPaneConnectionKey, type SftpConnection, type SftpSide } from '@/stores/sftpStore';
import { type UseSftpPaneActionsResult } from '@/hooks/useSftpPaneActions';
import type { FileEntry } from './utils';
import type { SftpDndPayload } from './sftp-dnd-context';
import { parentPortablePath } from '@/lib/path-utils';
import { hasActivePathOperation, useTransferStore } from '@/stores/transferStore';
import { useAppStore } from '@/stores/appStore';

export interface SftpPaneProps {
  connection: SftpConnection;
  side: SftpSide;
  actions: UseSftpPaneActionsResult;
  selectedPaths: Set<string>;
  onSelectedPathsChange: (paths: Set<string>) => void;
  onVerifyHostKey?: () => void;
  onReconnect?: () => void;
  systemDropActive?: boolean;
  systemDropHovered?: boolean;
  localMode?: boolean;
  onTitleClick?: () => void;
  onOpenTerminal?: () => void;
}

interface HistoryState {
  stack: string[];
  index: number;
}

export const SftpPane = React.forwardRef<HTMLDivElement, SftpPaneProps>(
  (
    {
      connection,
      side,
      actions,
      selectedPaths,
      onSelectedPathsChange,
      onVerifyHostKey,
      onReconnect,
      systemDropActive,
      systemDropHovered,
      localMode,
      onTitleClick,
      onOpenTerminal,
    },
    ref,
  ) => {
    const { t } = useI18n();
    const showHiddenFiles = useAppStore((state) => state.sftpShowHiddenFiles);
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
    const visibleEntries = useMemo(
      () => (showHiddenFiles ? entries : entries.filter((entry) => !entry.name.startsWith('.'))),
      [entries, showHiddenFiles],
    );
    const loading = side === 'local' ? connection.localLoading : connection.remoteLoading;
    const restorePending = !isLocal && connection.restorePending?.[side] === true;
    const error = restorePending
      ? t('sftp.restore.disconnected')
      : side === 'local' ? connection.localError : connection.remoteError;
    const isHostKeyError = !isLocal && !!error && (error.toLowerCase().includes('host key') || error.toLowerCase().includes('trust this host'));
    const pane = side === 'local' ? connection.localPane : connection.remotePane;
    const remoteBookmarks = connection.remoteBookmarks[side];

    const { loadLocalDirectory } = useLocalDirectory(connection, side);
    const { loadRemoteDirectory } = useSftpConnection(connection, side);

    const [history, setHistory] = useState<HistoryState>({
      stack: [path],
      index: 0,
    });
    // Mirror of `history` for event handlers: reading the ref keeps back /
    // forward navigation out of setState updaters, so StrictMode's double
    // invocation cannot fire the directory load twice.
    const historyRef = useRef(history);
    const updateHistory = useCallback((next: HistoryState): void => {
      historyRef.current = next;
      setHistory(next);
    }, []);

    // The pane mounts with an empty path and the real path only arrives once
    // the first directory load resolves. Sync that first entry so navigating
    // back can never land on the empty path.
    const initialPathSyncedRef = useRef(false);
    useEffect(() => {
      if (initialPathSyncedRef.current || !path) return;
      initialPathSyncedRef.current = true;
      const current = historyRef.current;
      if (current.index === 0 && current.stack.length === 1 && current.stack[0] !== path) {
        updateHistory({ stack: [path], index: 0 });
      }
    }, [path, updateHistory]);
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
    const [showSearch, setShowSearch] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const searchInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      if (showSearch && searchInputRef.current) {
        searchInputRef.current.focus();
      }
    }, [showSearch]);

    // The filter only applies to the directory it was typed in; carrying it
    // across a path change would hide the new listing behind a stale query.
    useEffect(() => {
      setSearchQuery('');
    }, [path]);

    // Escape dismisses the search the same way the search icon does (clear +
    // collapse). It stands down while a context/bookmark menu owns the key so
    // the menu still handles its own Escape first.
    useEffect(() => {
      if (!showSearch || fileContextMenu || blankContextMenu || bookmarkMenu) {
        return;
      }
      const handleKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          setShowSearch(false);
          setSearchQuery('');
        }
      };
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }, [blankContextMenu, bookmarkMenu, fileContextMenu, showSearch]);

    // Cmd/Ctrl+F opens the search. The handler lives on the pane root so the
    // bubbled keydown only fires when focus is inside this pane (e.g. the
    // file list), never the sibling pane.
    const handlePaneKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setShowSearch(true);
      }
    }, []);

    useEffect(() => {
      if (restorePending) return;
      if (isLocal) {
        loadLocalDirectory(path);
      } else {
        loadRemoteDirectory(path);
      }
    }, [isLocal, loadLocalDirectory, loadRemoteDirectory, restorePending]);

    const navigateTo = useCallback(
      (target: string, pushHistory = true): void => {
        if (isLocal) {
          loadLocalDirectory(target);
        } else {
          loadRemoteDirectory(target);
        }
        onSelectedPathsChange(new Set());

        if (pushHistory) {
          const current = historyRef.current;
          const stack = current.stack.slice(0, current.index + 1);
          if (stack[stack.length - 1] !== target) {
            updateHistory({ stack: [...stack, target], index: stack.length });
          }
        }
      },
      [isLocal, loadLocalDirectory, loadRemoteDirectory, onSelectedPathsChange, updateHistory],
    );

    useEffect(() => {
      const handleOpenPath = (event: Event): void => {
        const detail = (event as CustomEvent<{
          connectionId?: string;
          side?: SftpSide;
          path?: string;
        }>).detail;
        if (
          detail?.connectionId !== connection.id
          || detail.side !== side
          || !detail.path
        ) return;
        navigateTo(detail.path);
      };
      document.addEventListener('termbridge:open-sftp-path', handleOpenPath);
      return () => document.removeEventListener('termbridge:open-sftp-path', handleOpenPath);
    }, [connection.id, navigateTo, side]);

    const goBack = useCallback((): void => {
      const current = historyRef.current;
      if (current.index <= 0) return;
      const nextIndex = current.index - 1;
      navigateTo(current.stack[nextIndex], false);
      updateHistory({ ...current, index: nextIndex });
    }, [navigateTo, updateHistory]);

    const goForward = useCallback((): void => {
      const current = historyRef.current;
      if (current.index >= current.stack.length - 1) return;
      const nextIndex = current.index + 1;
      navigateTo(current.stack[nextIndex], false);
      updateHistory({ ...current, index: nextIndex });
    }, [navigateTo, updateHistory]);

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
        // Symlinks may point at a directory; try navigating and let a failure
        // surface through the pane's existing error state.
        if (entry.kind === 'directory' || entry.kind === 'symlink') {
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

    const paneTitle = isLocal ? t('sftp.local') : side === 'local' ? (connection.leftTitle ?? connection.title) : connection.title;

    const selectedEntries = useMemo(() => visibleEntries.filter((entry) => selectedPaths.has(entry.path)), [visibleEntries, selectedPaths]);
    // Stable array for SftpFileList: a fresh Array.from on every render would
    // defeat its memoized selection set on each transfer progress update.
    const selectedPathList = useMemo(() => Array.from(selectedPaths), [selectedPaths]);
    const transferOperations = useTransferStore((state) => state.operations);
    const selectionBusy =
      !isLocal &&
      hasActivePathOperation(
        getSftpPaneConnectionKey(connection, side),
        selectedEntries.map((entry) => entry.path),
        transferOperations,
      );
    const singleSelection = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
    const isCurrentPathBookmarked = path ? remoteBookmarks.includes(path) : false;

    const handleSelectAll = useCallback((): void => {
      onSelectedPathsChange(new Set(visibleEntries.map((entry) => entry.path)));
    }, [visibleEntries, onSelectedPathsChange]);

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
      (action: SftpFileContextMenuAction, targets?: FileEntry[]): void => {
        switch (action) {
          case 'open': {
            const target = selectedEntries[0];
            if (target) actions.onOpen(target);
            break;
          }
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
            // The confirmation dialog snapshots its targets while open; prefer
            // that snapshot over the live selection, which may have changed.
            void actions.onDelete(targets?.length ? targets : selectedEntries);
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
      <div ref={mergedRef} onKeyDown={handlePaneKeyDown} className="flex h-full flex-col overflow-hidden bg-app-surface">
        {/* Title bar */}
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-app-border/50 bg-app-surface px-1">
          {onTitleClick ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={onTitleClick}
              aria-label={t('sftp.source.switch')}
              className="min-w-0 max-w-[70%] justify-start px-1 h-8"
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
            {!isLocal && onOpenTerminal && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onOpenTerminal}
                className="h-[30px] w-7 shrink-0 rounded text-app-text-soft hover:bg-app-primary/10 hover:text-app-primary"
                aria-label={t('sftp.openTerminalHere')}
              >
                <SquareTerminalIcon />
              </Button>
            )}
            {/* Search — animated expand from icon. The inner row keeps a fixed
                width so the container clip-reveals it instead of squishing the
                input during the width transition. */}
            <div
              className={cn(
                'h-[30px] overflow-hidden rounded-md transition-[width,background-color] duration-200 ease-out',
                showSearch ? 'w-56 bg-app-surface-muted' : 'w-7 bg-transparent',
              )}
            >
              <div className="flex h-full w-56 items-center">
                <button
                  type="button"
                  onClick={() => {
                    if (showSearch) {
                      setShowSearch(false);
                      setSearchQuery('');
                    } else {
                      setShowSearch(true);
                    }
                  }}
                  className={cn(
                    'h-7 w-7 shrink-0 flex items-center justify-center rounded',
                    showSearch ? 'text-app-text hover:bg-app-border/50' : 'text-app-text-soft hover:bg-app-border/50 hover:text-app-text',
                  )}
                  aria-label={showSearch ? t('sftp.hideFilter') : t('sftp.showFilter')}
                >
                  <SearchIcon className="h-3.5 w-3.5" />
                </button>
                <div
                  className={cn(
                    'flex min-w-0 flex-1 items-center transition-opacity duration-150',
                    showSearch ? 'opacity-100 delay-75' : 'opacity-0',
                  )}
                >
                  <input
                    ref={searchInputRef}
                    type="text"
                    autoComplete="off"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t('sftp.filter')}
                    aria-label={t('sftp.filter')}
                    tabIndex={showSearch ? 0 : -1}
                    className="h-full min-w-0 flex-1 bg-transparent pr-2 text-sm text-app-text placeholder:text-app-text-soft/50 outline-none"
                  />
                </div>
              </div>
            </div>
            {!isLocal && remoteBookmarks.length > 0 && (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleBookmarkButtonClick}
                className="h-[30px] w-7 shrink-0 rounded text-app-text-soft hover:bg-app-primary/10 hover:text-app-primary [&_svg]:size-3.5"
                aria-label={t('sftp.contextMenu.bookmark.add')}
              >
                <BookmarkIcon />
              </Button>
            )}
          </div>
        </div>

        {/* Navigation row */}
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-app-border/50 bg-app-surface-muted px-1">
          <div className="flex items-center">
            <Button variant="ghost" size="icon" onClick={goBack} disabled={!canGoBack} className="h-6 w-6">
              <ChevronLeftIcon className={cn('h-4 w-4', !canGoBack && 'opacity-30')} />
            </Button>
            <Button variant="ghost" size="icon" onClick={goForward} disabled={!canGoForward} className="h-6 w-6">
              <ChevronRightIcon className={cn('h-4 w-4', !canGoForward && 'opacity-30')} />
            </Button>
          </div>

          <PathBreadcrumb path={path} onNavigate={navigateTo} normalizeInputPath={isLocal} className="flex-1" />
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
            // top-8 keeps the file-list header (h-8) visible while loading.
            <div className="absolute inset-x-0 bottom-0 top-8 z-10 flex flex-col items-center justify-center gap-2 bg-app-surface">
              <Spinner />
              <span className="text-xs text-app-text-soft">{t('common.loading')}</span>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-app-surface p-4 text-center text-xs text-app-error">
              <span>{error}</span>
              <Button
                variant="secondary"
                size="sm"
                onClick={
                  restorePending && onReconnect
                    ? onReconnect
                    : isHostKeyError && onVerifyHostKey
                      ? onVerifyHostKey
                      : () => navigateTo(path)
                }
              >
                {restorePending
                  ? t('sftp.restore.reconnect')
                  : isHostKeyError ? t('sftp.hostKey.verify') : t('common.retry')}
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
                  <Button
                    variant="default"
                    size="xs"
                    onClick={() => void actions.onBatchDownload()}
                    disabled={selectedEntries.length === 0 || selectionBusy}
                  >
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
              entries={visibleEntries}
              side={side}
              localMode={isLocal}
              selectedPaths={selectedPathList}
              filterQuery={searchQuery}
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
          hasClipboard={isLocal ? actions.hasLocalClipboard : !!connection.remoteClipboard}
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
  },
);
SftpPane.displayName = 'SftpPane';
