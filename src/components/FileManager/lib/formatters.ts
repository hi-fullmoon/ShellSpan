import { getActiveLocale, t } from '../../../lib/i18n';
import type { RemoteFileEntry, RemoteFileKind } from '../../../types';

export function formatDirectoryLoadError(error: unknown, requestedPath?: string): string {
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

export function formatSize(size?: number): string {
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

export function formatModified(modifiedAt?: number): string {
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

export function formatFullModified(modifiedAt?: number): string {
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

export function formatPermissionOctal(permissions?: number): string {
  if (permissions === undefined) {
    return '--';
  }

  return `0${(permissions & 0o7777).toString(8).padStart(4, '0')}`;
}

export function formatPermissionSymbolic(permissions: number | undefined, kind: RemoteFileKind): string {
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

  const prefix = kind === 'directory' ? 'd' : kind === 'symlink' ? 'l' : kind === 'file' ? '-' : '?';
  return `${prefix}${symbolic}`;
}

export function formatOwner(entry: RemoteFileEntry): string {
  return entry.ownerName?.trim() ? entry.ownerName : entry.ownerUid !== undefined ? `U${entry.ownerUid}` : '--';
}

export function formatGroup(entry: RemoteFileEntry): string {
  return entry.groupName?.trim() ? entry.groupName : entry.groupGid !== undefined ? `G${entry.groupGid}` : '--';
}

export function parentDirectoryPath(path: string): string {
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

export function localPathName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() ?? path;
}

export function createOperationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function kindLabel(kind: RemoteFileKind): string {
  switch (kind) {
    case 'directory':
      return t('fileManager.kind.directory');
    case 'file':
      return t('fileManager.kind.file');
    case 'symlink':
      return t('fileManager.kind.symlink');
    case 'other':
      return t('fileManager.kind.other');
    default:
      return kind;
  }
}
