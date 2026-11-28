import type { ConnectionProfile } from '@/types';
import { readLocalState, saveLocalState } from '@/lib/preferences/local-state';

export const CONNECTION_VIEW_MODES = ['card', 'table'] as const;
export type ConnectionViewMode = typeof CONNECTION_VIEW_MODES[number];
const STORAGE_KEY = 'shellspan.connections.viewMode';

export const CONNECTION_TABLE_SORT_COLUMNS = ['name', 'address', 'auth', 'group'] as const;
export type ConnectionTableSortColumn = typeof CONNECTION_TABLE_SORT_COLUMNS[number];
export type ConnectionTableSortDirection = 'asc' | 'desc';

export interface ConnectionTableSort {
  column: ConnectionTableSortColumn;
  direction: ConnectionTableSortDirection;
}

export function isConnectionViewMode(value: unknown): value is ConnectionViewMode {
  return CONNECTION_VIEW_MODES.some((mode) => mode === value);
}

export function readConnectionViewMode(): ConnectionViewMode {
  try {
    const saved = readLocalState(STORAGE_KEY);
    return isConnectionViewMode(saved) ? saved : 'card';
  } catch {
    return 'card';
  }
}

export function saveConnectionViewMode(mode: ConnectionViewMode): void {
  try {
    saveLocalState(STORAGE_KEY, mode);
  } catch {
    // View switching remains usable when local preference storage is unavailable.
  }
}

export function nextConnectionTableSort(
  current: ConnectionTableSort | null,
  column: ConnectionTableSortColumn,
): ConnectionTableSort | null {
  if (!current || current.column !== column) {
    return { column, direction: 'asc' };
  }
  if (current.direction === 'asc') {
    return { column, direction: 'desc' };
  }
  return null;
}

export function sortConnectionsForTable(
  profiles: readonly ConnectionProfile[],
  sort: ConnectionTableSort | null,
  locale: string,
  authLabel: (method: ConnectionProfile['authMethod']) => string,
): ConnectionProfile[] {
  if (!sort) return [...profiles];
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const direction = sort.direction === 'asc' ? 1 : -1;

  return [...profiles].sort((left, right) => {
    if (sort.column === 'name') {
      return direction * collator.compare(
        left.name.trim() || left.host,
        right.name.trim() || right.host,
      );
    }
    if (sort.column === 'address') {
      const hostCompare = collator.compare(left.host, right.host);
      if (hostCompare !== 0) return direction * hostCompare;
      if (left.port !== right.port) return direction * (left.port - right.port);
      return direction * collator.compare(left.username, right.username);
    }
    if (sort.column === 'auth') {
      return direction * collator.compare(authLabel(left.authMethod), authLabel(right.authMethod));
    }
    // Always keep ungrouped connections at the bottom regardless of sort direction.
    const leftGroup = left.group?.trim() ?? '';
    const rightGroup = right.group?.trim() ?? '';
    if (!leftGroup && !rightGroup) return 0;
    if (!leftGroup) return 1;
    if (!rightGroup) return -1;
    return direction * collator.compare(leftGroup, rightGroup);
  });
}
