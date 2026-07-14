import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/empty-state';
import { PathBreadcrumb } from './path-breadcrumb';
import { SftpFileList } from './sftp-file-list';
import { SftpPaneActions } from './sftp-pane-actions';
import {
  SftpFileContextMenu,
  type SftpFileContextMenuAction,
} from './sftp-file-context-menu';
import { useLocalDirectory } from '@/hooks/useLocalDirectory';
import { useSftpConnection } from '@/hooks/useSftpConnection';
import { useSftpStore, type SftpConnection, type SftpSide } from '@/stores/sftpStore';
import type { FileEntry } from './file-entry-formatters';

export type SftpPaneFileAction = 'open' | 'rename' | 'delete' | 'permissions';

export interface SftpPaneProps {
  connection: SftpConnection;
  side: SftpSide;
  selectedPaths: Set<string>;
  onSelectedPathsChange: (paths: Set<string>) => void;
  onNewFolder?: () => void;
  onFileAction?: (action: SftpPaneFileAction) => void;
}

interface HistoryState {
  stack: string[];
  index: number;
}

const BackIcon: React.FC<{ disabled?: boolean }> = ({ disabled }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className={cn('h-4 w-4', disabled && 'opacity-30')}
  >
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);

const ForwardIcon: React.FC<{ disabled?: boolean }> = ({ disabled }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className={cn('h-4 w-4', disabled && 'opacity-30')}
  >
    <path d="M5 12h14M12 5l7 7-7 7" />
  </svg>
);

const SearchIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="h-3.5 w-3.5"
  >
    <circle cx="11" cy="11" r="8" />
    <path d="M21 21l-4.35-4.35" />
  </svg>
);

export const SftpPane: React.FC<SftpPaneProps> = ({
  connection,
  side,
  selectedPaths,
  onSelectedPathsChange,
  onNewFolder,
  onFileAction,
}) => {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({
    id: `sftp-pane-${side}-${connection.id}`,
    data: { side },
  });

  const isLocal = side === 'local';
  const path = isLocal ? connection.localPath : connection.remotePath;
  const entries = isLocal ? connection.localEntries : connection.remoteEntries;
  const loading = isLocal ? connection.localLoading : connection.remoteLoading;
  const error = isLocal ? connection.localError : connection.remoteError;
  const pane = isLocal ? connection.localPane : connection.remotePane;

  const setPaneState = useSftpStore((state) => state.setPaneState);

  const { loadLocalDirectory } = useLocalDirectory(connection);
  const { loadRemoteDirectory } = useSftpConnection(connection);

  const [history, setHistory] = useState<HistoryState>({
    stack: [path],
    index: 0,
  });
  const [filterVisible, setFilterVisible] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry;
  } | null>(null);

  useEffect(() => {
    if (isLocal) {
      loadLocalDirectory('');
    } else {
      loadRemoteDirectory('');
    }
  }, [isLocal, loadLocalDirectory, loadRemoteDirectory]);

  useEffect(() => {
    setPaneState(connection.id, side, { pathInput: path });
  }, [connection.id, side, path, setPaneState]);

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

  const handlePathInputChange = (value: string): void => {
    setPaneState(connection.id, side, { pathInput: value });
  };

  const handlePathInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      navigateTo(pane.pathInput);
    }
  };

  const handleParentDirectory = useCallback((): void => {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length === 0) return;
    parts.pop();
    const parent = normalized.startsWith('/')
      ? `/${parts.join('/')}`
      : parts.join('/');
    navigateTo(parent || '/');
  }, [path, navigateTo]);

  const handleFilterChange = (value: string): void => {
    setPaneState(connection.id, side, { filterQuery: value });
  };

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

  const handleContextMenu = useCallback(
    (entry: FileEntry, e: React.MouseEvent): void => {
      e.preventDefault();
      if (!selectedPaths.has(entry.path)) {
        onSelectedPathsChange(new Set([entry.path]));
      }
      setContextMenu({ x: e.clientX, y: e.clientY, entry });
    },
    [selectedPaths, onSelectedPathsChange],
  );

  const handleContextMenuAction = useCallback(
    (action: SftpFileContextMenuAction): void => {
      if (action === 'open') {
        const target = Array.from(selectedPaths)[0];
        const entry = entries.find((e) => e.path === target);
        if (entry?.kind === 'directory') {
          navigateTo(entry.path);
        }
        return;
      }
      onFileAction?.(action);
    },
    [entries, navigateTo, onFileAction, selectedPaths],
  );

  const handleToggleBatchMode = useCallback((): void => {
    setPaneState(connection.id, side, { batchMode: !pane.batchMode });
    onSelectedPathsChange(new Set());
  }, [connection.id, pane.batchMode, setPaneState, side, onSelectedPathsChange]);

  const paneTitle = isLocal ? t('sftp.local') : connection.title;

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedPaths.has(entry.path)),
    [entries, selectedPaths],
  );

  const canGoBack = history.index > 0;
  const canGoForward = history.index < history.stack.length - 1;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex h-full flex-col overflow-hidden border border-app-border bg-app-surface',
        isOver && 'ring-2 ring-inset ring-app-primary',
      )}
    >
      {/* Title bar */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-app-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold text-app-text">{paneTitle}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setFilterVisible((prev) => !prev)}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium transition-colors',
              filterVisible
                ? 'bg-app-primary text-app-primary-text'
                : 'bg-app-surface-muted text-app-text hover:bg-app-border',
            )}
          >
            <SearchIcon />
            <span className="hidden sm:inline">{t('sftp.filter')}</span>
          </button>
          <SftpPaneActions
            side={side}
            batchMode={pane.batchMode}
            filterVisible={filterVisible}
            onRefresh={() => navigateTo(path)}
            onParentDirectory={handleParentDirectory}
            onToggleFilter={() => setFilterVisible((prev) => !prev)}
            onToggleBatchMode={handleToggleBatchMode}
            onNewFolder={onNewFolder}
          />
        </div>
      </div>

      {/* Navigation row */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-app-border bg-app-surface-muted px-2">
        <div className="flex items-center">
          <button
            onClick={goBack}
            disabled={!canGoBack}
            className="flex h-6 w-6 items-center justify-center rounded-md text-app-text-soft hover:bg-app-border hover:text-app-text disabled:pointer-events-none"
          >
            <BackIcon disabled={!canGoBack} />
          </button>
          <button
            onClick={goForward}
            disabled={!canGoForward}
            className="flex h-6 w-6 items-center justify-center rounded-md text-app-text-soft hover:bg-app-border hover:text-app-text disabled:pointer-events-none"
          >
            <ForwardIcon disabled={!canGoForward} />
          </button>
        </div>

        <PathBreadcrumb
          path={path}
          onNavigate={navigateTo}
          homeLabel={t('sftp.path.home')}
          className="flex-1"
        />

        <Input
          value={pane.pathInput}
          onChange={(e) => handlePathInputChange(e.target.value)}
          onKeyDown={handlePathInputKeyDown}
          className="hidden h-6 w-40 border-0 bg-transparent px-1 py-0 text-xs shadow-none focus-visible:ring-0 sm:block"
          aria-label={isLocal ? t('sftp.localPath') : t('sftp.remotePath')}
        />
      </div>

      {/* Filter input */}
      {filterVisible && (
        <div className="flex h-8 shrink-0 items-center border-b border-app-border px-2">
          <div className="flex flex-1 items-center gap-1.5 rounded-md bg-app-surface-muted px-2">
            <SearchIcon />
            <Input
              value={pane.filterQuery}
              onChange={(e) => handleFilterChange(e.target.value)}
              placeholder={t('sftp.filter')}
              className="h-7 flex-1 border-0 bg-transparent px-0 py-0 text-xs shadow-none focus-visible:ring-0"
              autoFocus
            />
          </div>
        </div>
      )}

      {/* File list */}
      <div className="relative flex-1 min-h-0">
        {loading && entries.length === 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-app-surface">
            <Spinner />
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-app-surface p-4 text-center text-xs text-app-error">
            <span>{error}</span>
            <button
              onClick={() => navigateTo(path)}
              className="rounded-lg bg-app-surface-muted px-3 py-1.5 text-xs font-medium text-app-text hover:bg-app-border"
            >
              {t('common.retry')}
            </button>
          </div>
        )}
        {!error && (
          <SftpFileList
            entries={entries}
            side={side}
            selectedPaths={Array.from(selectedPaths)}
            filterQuery={pane.filterQuery}
            batchMode={pane.batchMode}
            onSelect={handleSelect}
            onDoubleClick={handleDoubleClick}
            onContextMenu={handleContextMenu}
          />
        )}
      </div>

      <SftpFileContextMenu
        open={!!contextMenu}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        side={side}
        selectedEntries={selectedEntries}
        onClose={() => setContextMenu(null)}
        onAction={handleContextMenuAction}
      />
    </div>
  );
};

export function isRemoteEntry(
  entry: FileEntry,
  side: SftpSide,
): entry is import('@/types').RemoteFileEntry {
  return side === 'remote';
}

export function isLocalEntry(
  entry: FileEntry,
  side: SftpSide,
): entry is import('@/types').LocalFileEntry {
  return side === 'local';
}
