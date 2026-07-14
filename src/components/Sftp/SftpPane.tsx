import React, { useEffect } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Spinner } from '@/components/ui/EmptyState';
import { PathBreadcrumb } from './PathBreadcrumb';
import { SftpFileGrid, type FileEntry } from './SftpFileGrid';
import { useLocalDirectory } from '@/hooks/useLocalDirectory';
import { useSftpConnection } from '@/hooks/useSftpConnection';
import { useSftpStore, type SftpConnection, type SftpSide } from '@/stores/sftpStore';

export interface SftpPaneProps {
  connection: SftpConnection;
  side: SftpSide;
  selectedPaths: Set<string>;
  onSelectedPathsChange: (paths: Set<string>) => void;
}

export const SftpPane: React.FC<SftpPaneProps> = ({
  connection,
  side,
  selectedPaths,
  onSelectedPathsChange,
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

  const handleNavigate = (target: string): void => {
    if (isLocal) {
      loadLocalDirectory(target);
    } else {
      loadRemoteDirectory(target);
    }
    onSelectedPathsChange(new Set());
  };

  const handlePathInputChange = (value: string): void => {
    setPaneState(connection.id, side, { pathInput: value });
  };

  const handlePathInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      handleNavigate(pane.pathInput);
    }
  };

  const handleParentDirectory = (): void => {
    const normalized = path.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length === 0) return;
    parts.pop();
    const parent = normalized.startsWith('/')
      ? `/${parts.join('/')}`
      : parts.join('/');
    handleNavigate(parent || '/');
  };

  const handleFilterChange = (value: string): void => {
    setPaneState(connection.id, side, { filterQuery: value });
  };

  const handleSelect = (paths: string[]): void => {
    onSelectedPathsChange(new Set(paths));
  };

  const handleDoubleClick = (entry: FileEntry): void => {
    if (entry.kind === 'directory') {
      handleNavigate(entry.path);
    }
  };

  const handleContextMenu = (entry: FileEntry, e: React.MouseEvent): void => {
    e.preventDefault();
    onSelectedPathsChange(new Set([entry.path]));
  };

  const isEmpty = entries.length === 0;

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex h-full flex-col overflow-hidden border border-app-border bg-app-surface',
        isOver && 'ring-2 ring-inset ring-app-primary',
      )}
    >
      <div className="flex h-9 items-center justify-between border-b border-app-border px-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-app-text-soft">
            {isLocal ? t('sftp.local') : t('sftp.remote')}
          </span>
          <Input
            value={pane.pathInput}
            onChange={(e) => handlePathInputChange(e.target.value)}
            onKeyDown={handlePathInputKeyDown}
            className="h-6 w-48 border-0 bg-transparent px-1 py-0 text-xs shadow-none focus-visible:ring-0"
            aria-label={isLocal ? t('sftp.localPath') : t('sftp.remotePath')}
          />
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleParentDirectory}
            title={t('sftp.parentDirectory')}
            className="h-6 w-6"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-3.5 w-3.5"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => handleNavigate(path)}
            title={t('common.refresh')}
            className="h-6 w-6"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-3.5 w-3.5"
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </Button>
          <Input
            value={pane.filterQuery}
            onChange={(e) => handleFilterChange(e.target.value)}
            placeholder={t('sftp.filter')}
            className="h-6 w-24 border-0 bg-app-surface-muted px-2 py-0 text-xs shadow-none focus-visible:ring-1"
          />
        </div>
      </div>

      <div className="border-b border-app-border p-2">
        <PathBreadcrumb
          path={path}
          onNavigate={handleNavigate}
          homeLabel={t('sftp.path.home')}
        />
      </div>

      <div className="relative flex-1 min-h-0">
        {loading && isEmpty && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-app-surface">
            <Spinner />
          </div>
        )}
        {error && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-app-surface p-4 text-center text-xs text-app-error">
            <span>{error}</span>
            <Button variant="secondary" size="sm" onClick={() => handleNavigate(path)}>
              {t('common.retry')}
            </Button>
          </div>
        )}
        {!error && (
          <SftpFileGrid
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
