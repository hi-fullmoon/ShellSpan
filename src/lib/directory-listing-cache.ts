import type { RemoteDirectoryListing } from '@/types';

// Short-lived cache of remote directory listings so back/forward navigation
// and revisiting a folder render instantly; the caller always revalidates
// against the server in the background and overwrites the entry.
const TTL_MS = 60_000;
const MAX_KEYS = 100;

interface CachedListing {
  scope: string;
  listing: RemoteDirectoryListing;
  cachedAt: number;
}

const cache = new Map<string, CachedListing>();

function cacheKey(scope: string, path: string): string {
  return JSON.stringify([scope, path]);
}

export function getCachedDirectoryListing(
  scope: string,
  path: string,
): RemoteDirectoryListing | undefined {
  const key = cacheKey(scope, path);
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (Date.now() - cached.cachedAt > TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return cached.listing;
}

export function setCachedDirectoryListing(
  scope: string,
  path: string,
  listing: RemoteDirectoryListing,
): void {
  const key = cacheKey(scope, path);
  // Refresh insertion order so the oldest key is evicted first.
  cache.delete(key);
  cache.set(key, { scope, listing, cachedAt: Date.now() });
  if (cache.size > MAX_KEYS) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
}

// Drops every cached listing belonging to one exact pane/remote identity.
// Mutating operations call this so the post-mutation reload never flashes the
// pre-mutation entries or affects another host attached to the same pane.
export function invalidateDirectoryListingCache(scope: string): void {
  for (const [key, cached] of cache) {
    if (cached.scope === scope) {
      cache.delete(key);
    }
  }
}

// Test isolation: the cache is module-level, so without an explicit reset
// one test's listing would leak into the next test sharing a connection id.
export function clearDirectoryListingCache(): void {
  cache.clear();
}
