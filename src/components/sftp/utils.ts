import type { LocalFileEntry, RemoteFileEntry, RemoteFileKind } from '@/types';

export type FileEntry = LocalFileEntry | RemoteFileEntry;

export function isRemoteEntry(entry: FileEntry): entry is RemoteFileEntry {
  return (
    'permissions' in entry ||
    'ownerUid' in entry ||
    'groupGid' in entry ||
    'ownerName' in entry ||
    'groupName' in entry
  );
}

function permissionTypePrefix(kind: RemoteFileKind): string {
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

export function formatPermissionSymbolic(
  permissions: number | undefined,
  kind: RemoteFileKind,
): string {
  if (permissions === undefined) {
    return '--';
  }

  const ownerExec = (permissions & 0o100) === 0o100;
  const groupExec = (permissions & 0o010) === 0o010;
  const otherExec = (permissions & 0o001) === 0o001;
  const symbolic = [
    (permissions & 0o400) === 0o400 ? 'r' : '-',
    (permissions & 0o200) === 0o200 ? 'w' : '-',
    (permissions & 0o4000) === 0o4000
      ? ownerExec
        ? 's'
        : 'S'
      : ownerExec
        ? 'x'
        : '-',
    (permissions & 0o040) === 0o040 ? 'r' : '-',
    (permissions & 0o020) === 0o020 ? 'w' : '-',
    (permissions & 0o2000) === 0o2000
      ? groupExec
        ? 's'
        : 'S'
      : groupExec
        ? 'x'
        : '-',
    (permissions & 0o004) === 0o004 ? 'r' : '-',
    (permissions & 0o002) === 0o002 ? 'w' : '-',
    (permissions & 0o1000) === 0o1000
      ? otherExec
        ? 't'
        : 'T'
      : otherExec
        ? 'x'
        : '-',
  ].join('');

  return `${permissionTypePrefix(kind)}${symbolic}`;
}

export function formatOwner(entry: RemoteFileEntry): string {
  return entry.ownerName?.trim()
    ? entry.ownerName
    : entry.ownerUid !== undefined
      ? `U${entry.ownerUid}`
      : '--';
}

export function formatGroup(entry: RemoteFileEntry): string {
  return entry.groupName?.trim()
    ? entry.groupName
    : entry.groupGid !== undefined
      ? `G${entry.groupGid}`
      : '--';
}
