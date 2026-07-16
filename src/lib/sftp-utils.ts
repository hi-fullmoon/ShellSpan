import type { LocaleKey } from '@/locales';
import type { RemoteFileKind } from '@/types';
import { parentPortablePath } from '@/lib/path-utils';

export function formatSize(size?: number): string {
  if (size === undefined) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatModified(modifiedAt?: number, locale = 'en-US'): string {
  if (!modifiedAt) return '--';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(modifiedAt * 1000));
}

export function kindLabel(
  kind: RemoteFileKind,
  t: (key: LocaleKey, variables?: Record<string, string | number>) => string,
): string {
  switch (kind) {
    case 'directory':
      return t('sftp.kind.directory');
    case 'file':
      return t('sftp.kind.file');
    case 'symlink':
      return t('sftp.kind.symlink');
    case 'other':
    default:
      return t('sftp.kind.other');
  }
}

export function parentDirectoryPath(path: string): string {
  return parentPortablePath(path);
}

export function permissionTypePrefix(kind: RemoteFileKind): string {
  switch (kind) {
    case 'directory':
      return 'd';
    case 'symlink':
      return 'l';
    case 'file':
      return '-';
    case 'other':
    default:
      return '?';
  }
}

export function formatPermissionSymbolic(permissions: number | undefined, kind: RemoteFileKind): string {
  if (permissions === undefined) return '--';

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

export function formatPermissionOctal(permissions?: number): string {
  if (permissions === undefined) return '--';
  return `0${(permissions & 0o7777).toString(8).padStart(4, '0')}`;
}

export function formatOwner(entry: { ownerName?: string; ownerUid?: number }): string {
  return entry.ownerName?.trim()
    ? entry.ownerName
    : entry.ownerUid !== undefined
      ? `U${entry.ownerUid}`
      : '--';
}

export function formatGroup(entry: { groupName?: string; groupGid?: number }): string {
  return entry.groupName?.trim()
    ? entry.groupName
    : entry.groupGid !== undefined
      ? `G${entry.groupGid}`
      : '--';
}

export function formatOwnership(entry: {
  ownerName?: string;
  ownerUid?: number;
  groupName?: string;
  groupGid?: number;
}): string {
  return `${formatOwner(entry)}:${formatGroup(entry)}`;
}
