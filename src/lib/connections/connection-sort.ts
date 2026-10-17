import type { ConnectionProfile } from '@/types';

export const CONNECTION_SORT_MODES = ['default', 'name', 'recent', 'created'] as const;
export type ConnectionSortMode = typeof CONNECTION_SORT_MODES[number];
const STORAGE_KEY = 'shellspan.connections.sort';

export function isConnectionSortMode(value: unknown): value is ConnectionSortMode {
  return CONNECTION_SORT_MODES.some(mode => mode === value);
}

export function readConnectionSort(): ConnectionSortMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isConnectionSortMode(saved) ? saved : 'default';
  } catch {
    return 'default';
  }
}

export function saveConnectionSort(mode: ConnectionSortMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Sorting remains usable when local preference storage is unavailable.
  }
}

export function sortConnections(
  profiles: readonly ConnectionProfile[],
  mode: ConnectionSortMode,
  recentIds: readonly string[],
  locale: string,
): ConnectionProfile[] {
  const result = [...profiles];
  if (mode === 'name') {
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    result.sort((left, right) => collator.compare(left.name.trim() || left.host, right.name.trim() || right.host));
  } else if (mode === 'recent') {
    const ranks = new Map(recentIds.map((id, index) => [id, index]));
    result.sort((left, right) => (ranks.get(left.id) ?? recentIds.length) - (ranks.get(right.id) ?? recentIds.length));
  } else if (mode === 'created') {
    result.sort((left, right) => right.createdAt - left.createdAt);
  }
  return result;
}
