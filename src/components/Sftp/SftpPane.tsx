import React, { useEffect } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { cn } from '@/lib/utils';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/EmptyState';
import { PathBreadcrumb } from './PathBreadcrumb';
import { FileGrid, type FileEntry } from './FileGrid';
import { useLocalDirectory } from '@/hooks/useLocalDirectory';
import { useSftpConnection } from '@/hooks/useSftpConnection';
import { useSftpStore, type SftpConnection, type SftpSide } from '@/stores/sftpStore';
import type { LocalFileEntry, RemoteFileEntry } from '@/types';

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
  const entries = isLocal
    ? connection.localEntries
    : connection.remoteEntries;
  const loading = isLocal
    ? connection.localLoading
    : connection.remoteLoading;
  const error = isLocal ? connection.localError : connection.remoteError;

  const { loadLocalDirectory } = useLocalDirectory(connection);
  const { loadRemoteDirectory } = useSftpConnection(connection);

  useEffect(() => {
    if (isLocal) {
      loadLocalDirectory('');
    } else {
      loadRemoteDirectory('');
    }
  }, [isLocal, loadLocalDirectory, loadRemoteDirectory]);

  const handleNavigate = (target: string): void => {
    if (isLocal) {
      loadLocalDirectory(target);
    } else {
      loadRemoteDirectory(target);
    }
    onSelectedPathsChange(new Set());
  };

  const handleSelect = (targetPath: string, multi: boolean): void => {
    const next = new Set(selectedPaths);
    if (multi) {
      if (next.has(targetPath)) {
        next.delete(targetPath);
      } else {
        next.add(targetPath);
      }
    } else {
      next.clear();
      next.add(targetPath);
    }
    onSelectedPathsChange(next);
  };

  const handleDoubleClick = (entry: FileEntry): void => {
    if (entry.kind === 'directory') {
      handleNavigate(entry.path);
    }
  };

  const handleContextMenu = (entry: FileEntry, e: React.MouseEvent): void => {
    e.preventDefault();
    handleSelect(entry.path, false);
  };

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex h-full flex-col overflow-hidden border border-app-border bg-app-surface',
        isOver && 'ring-2 ring-inset ring-app-primary',
      )}
    >
      <div className="flex h-9 items-center justify-between border-b border-app-border px-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-app-text-soft">
          {isLocal ? t('sftp.local') : t('sftp.remote')}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => handleNavigate(path)}
            title={t('common.refresh')}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </Button>
        </div>
      </div>

      <div className="border-b border-app-border p-2">
        <PathBreadcrumb
          path={path}
          onNavigate={handleNavigate}
          homeLabel={t('sftp.path.home')}
        />
      </div>

      <div className="flex-1 min-h-0">
        {loading && entries.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
        {error && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-app-error">
            <span>{error}</span>
            <Button variant="secondary" size="sm" onClick={() => handleNavigate(path)}>
              {t('common.retry')}
            </Button>
          </div>
        )}
        {!loading && !error && (
          <FileGrid
            entries={entries}
            selectedPaths={selectedPaths}
            side={side}
            onSelect={handleSelect}
            onDoubleClick={handleDoubleClick}
            onContextMenu={handleContextMenu}
            loading={loading}
          />
        )}
      </div>
    </div>
  );
};

export function isRemoteEntry(
  entry: FileEntry,
  side: SftpSide,
): entry is RemoteFileEntry {
  return side === 'remote';
}

export function isLocalEntry(
  entry: FileEntry,
  side: SftpSide,
): entry is LocalFileEntry {
  return side === 'local';
}
