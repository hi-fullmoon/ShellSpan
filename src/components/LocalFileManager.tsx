import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState } from 'react';
import { t } from '../lib/i18n';
import { cn, detectFileType, fileKindColor } from '../lib/ui';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  FileIcon,
  FolderIcon,
  HomeIcon,
  ImageIcon,
  CodeFileIcon,
  JsonFileIcon,
  MarkdownFileIcon,
  HtmlFileIcon,
  LinkIcon,
  ScrollArea,
  SearchIcon,
} from './ui';
import type { LocalDirectoryListing, LocalFileEntry, RemoteFileKind } from '../types';

interface LocalFileManagerProps {
  className?: string;
}

function formatSize(size?: number) {
  if (size === undefined || size === null) return '--';
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
  if (!modifiedAt) return '--';
  return new Date(modifiedAt * 1000).toLocaleString();
}

function fileKindLabel(kind: RemoteFileKind) {
  switch (kind) {
    case 'directory':
      return 'folder';
    case 'symlink':
      return 'symlink';
    case 'other':
      return 'other';
    default:
      return 'file';
  }
}

function FileTypeIcon({ name, kind }: { name: string; kind: RemoteFileKind }) {
  const type = detectFileType(name, kind);
  const colorClass = kind === 'directory' ? 'text-sky-400' : fileKindColor(kind);

  switch (type) {
    case 'folder':
      return <FolderIcon className={cn('h-5 w-5', colorClass)} />;
    case 'image':
      return <ImageIcon className={cn('h-5 w-5', colorClass)} />;
    case 'json':
      return <JsonFileIcon className={cn('h-5 w-5', colorClass)} />;
    case 'markdown':
      return <MarkdownFileIcon className={cn('h-5 w-5', colorClass)} />;
    case 'html':
      return <HtmlFileIcon className={cn('h-5 w-5', colorClass)} />;
    case 'code':
      return <CodeFileIcon className={cn('h-5 w-5', colorClass)} />;
    case 'symlink':
      return <LinkIcon className={cn('h-5 w-5', colorClass)} />;
    default:
      return <FileIcon className={cn('h-5 w-5', colorClass)} />;
  }
}

function buildBreadcrumbs(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const isAbsolute = normalized.startsWith('/');
  const parts = normalized.split('/').filter(Boolean);
  const crumbs: { name: string; path: string }[] = [];
  let current = isAbsolute ? '' : '.';

  for (const part of parts) {
    current = current === '' ? `/${part}` : `${current}/${part}`;
    crumbs.push({ name: part, path: current });
  }

  return crumbs;
}

export function LocalFileManager({ className }: LocalFileManagerProps) {
  const [path, setPath] = useState('.');
  const [listing, setListing] = useState<LocalDirectoryListing | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [editPath, setEditPath] = useState('');

  const loadDirectory = async (targetPath?: string) => {
    const requestedPath = targetPath ?? path;
    setLoading(true);
    setError(undefined);
    setSelectedPath(undefined);
    setIsEditingPath(false);
    try {
      const result = await invoke<LocalDirectoryListing>('list_local_directory', { path: requestedPath });
      setListing(result);
      setPath(result.path);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const startPathEdit = () => {
    setEditPath(listing?.path ?? path);
    setIsEditingPath(true);
  };

  const cancelPathEdit = () => {
    setIsEditingPath(false);
  };

  const submitPathEdit = (event?: React.FormEvent) => {
    event?.preventDefault();
    const nextPath = editPath.trim();
    if (!nextPath) {
      cancelPathEdit();
      return;
    }
    void loadDirectory(nextPath);
  };

  useEffect(() => {
    void loadDirectory();
  }, []);

  const breadcrumbs = useMemo(() => buildBreadcrumbs(listing?.path ?? path), [listing?.path, path]);

  return (
    <aside className={cn('flex min-h-0 flex-col overflow-hidden bg-[var(--app-bg)]', className)}>
      {/* Header */}
      <div className="flex h-11 items-center justify-between border-b border-[var(--app-border)] px-3">
        <div className="flex items-center gap-2">
          <div className="grid h-6 w-6 place-items-center rounded bg-[var(--app-primary-bg)] text-[var(--app-primary-text)]">
            <HomeIcon className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold text-[var(--app-text)]">{t('sftp.local')}</span>
        </div>
        <div className="flex items-center gap-1">
          <button className="btn-ghost h-7 gap-1 px-2 text-xs" type="button">
            <SearchIcon className="h-3.5 w-3.5" />
            {t('fileManager.actions.filter')}
          </button>
          <button className="btn-ghost h-7 gap-1 px-2 text-xs" type="button">
            {t('fileManager.actions.actions')}
            <ChevronDownIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-3 py-1.5">
        <button className="icon-btn h-6 w-6" disabled type="button">
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <button className="icon-btn h-6 w-6" disabled type="button">
          <ArrowRightIcon className="h-4 w-4" />
        </button>
        <div
          className="flex h-7 min-w-0 flex-1 items-center gap-1 overflow-hidden rounded-md border border-[var(--app-border)] bg-[var(--app-surface-muted)] px-2"
          onDoubleClick={startPathEdit}
        >
          {isEditingPath ? (
            <form className="min-w-0 flex-1" onSubmit={submitPathEdit}>
              <input
                autoFocus
                className="h-full w-full border-0 bg-transparent p-0 text-xs leading-none text-[var(--app-text)] outline-none"
                onBlur={cancelPathEdit}
                onChange={(event) => setEditPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    cancelPathEdit();
                  }
                }}
                type="text"
                value={editPath}
              />
            </form>
          ) : (
            breadcrumbs.map((crumb, index) => (
              <span key={crumb.path} className="flex items-center gap-1">
                {index > 0 && <span className="text-[var(--app-text-muted)]">/</span>}
                <button
                  className="truncate text-xs text-[var(--app-text-soft)] hover:text-[var(--app-text)]"
                  onClick={() => void loadDirectory(crumb.path)}
                  type="button"
                >
                  {crumb.name}
                </button>
              </span>
            ))
          )}
        </div>
      </div>

      {error ? (
        <div className="border border-rose-900 bg-rose-950/40 px-2 py-2 text-xs text-rose-300 rounded-sm m-2">
          {error}
        </div>
      ) : null}

      <ScrollArea className="flex-1">
        {loading && !listing ? (
          <div className="text-subtle px-3 py-2 text-xs">{t('fileManager.loading')}</div>
        ) : !listing ? null : (
          <table className="w-full table-fixed text-left text-xs">
            <thead className="sticky top-0 z-10 bg-[var(--app-bg)] text-[var(--app-text-muted)]">
              <tr className="border-b border-[var(--app-border)]">
                <th className="w-[55%] px-3 py-1.5 font-medium">{t('fileManager.columns.name')}</th>
                <th className="w-[25%] px-3 py-1.5 font-medium">{t('fileManager.columns.time')}</th>
                <th className="w-[12%] px-3 py-1.5 font-medium">{t('fileManager.columns.size')}</th>
                <th className="w-[8%] px-3 py-1.5 font-medium">{t('fileManager.columns.type')}</th>
              </tr>
            </thead>
            <tbody>
              {listing.parentPath && (
                <LocalFileParentRow
                  selected={selectedPath === `${listing.parentPath}/..`}
                  onClick={() => setSelectedPath(`${listing.parentPath}/..`)}
                  onDoubleClick={() => listing.parentPath && void loadDirectory(listing.parentPath)}
                />
              )}
              {listing.entries.map((entry) => (
                <LocalFileRow
                  key={entry.path}
                  entry={entry}
                  selected={selectedPath === entry.path}
                  onClick={() => setSelectedPath(entry.path)}
                  onDoubleClick={() => {
                    if (entry.kind === 'directory') {
                      void loadDirectory(entry.path);
                    }
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
      </ScrollArea>
    </aside>
  );
}

function LocalFileParentRow({
  selected,
  onClick,
  onDoubleClick,
}: {
  selected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  return (
    <tr
      className={cn(
        'cursor-default border-b border-[var(--app-border)] transition hover:bg-[var(--app-surface-hover)]',
        selected && 'bg-[var(--app-surface-active)]',
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-2">
          <FolderIcon className="h-5 w-5 text-sky-400" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-[var(--app-text)]">..</div>
            <div className="truncate text-[10px] text-[var(--app-text-muted)]">{t('fileManager.parentDirectory')}</div>
          </div>
        </div>
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap text-[var(--app-text-soft)]">--</td>
      <td className="px-3 py-1.5 whitespace-nowrap text-[var(--app-text-soft)]">--</td>
      <td className="px-3 py-1.5 whitespace-nowrap text-[var(--app-text-soft)]">{t('fileManager.kind.directory')}</td>
    </tr>
  );
}

function LocalFileRow({
  entry,
  selected,
  onClick,
  onDoubleClick,
}: {
  entry: LocalFileEntry;
  selected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  return (
    <tr
      className={cn(
        'cursor-default border-b border-[var(--app-border)] transition hover:bg-[var(--app-surface-hover)]',
        selected && 'bg-[var(--app-surface-active)]',
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-2">
          <FileTypeIcon kind={entry.kind} name={entry.name} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-[var(--app-text)]">{entry.name}</div>
            <div className="truncate text-[10px] text-[var(--app-text-muted)]">{entry.kind === 'directory' ? 'drwxr-xr-x@' : '-rw-r--r--@'}</div>
          </div>
        </div>
      </td>
      <td className="px-3 py-1.5 whitespace-nowrap text-[var(--app-text-soft)]">{formatModified(entry.modifiedAt)}</td>
      <td className="px-3 py-1.5 whitespace-nowrap text-[var(--app-text-soft)]">{formatSize(entry.size)}</td>
      <td className="px-3 py-1.5 whitespace-nowrap text-[var(--app-text-soft)]">{fileKindLabel(entry.kind)}</td>
    </tr>
  );
}
