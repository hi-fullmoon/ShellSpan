import type { RemoteDirectoryListing } from '@/types';

// Short-lived cache of remote directory listings so back/forward navigation
// and revisiting a folder render instantly; the caller always revalidates
// against the server in the background and overwrites the entry.
const TTL_MS = 60_000;
const MAX_KEYS = 100;

interface CachedListing {
  listing: RemoteDirectoryListing;
  cachedAt: number;
}

const cache = new Map<string, CachedListing>();

export function getCachedDirectoryListing(key: string): RemoteDirectoryListing | undefined {
  const cached = cache.get(key);
  if (!cached) return undefined;
  if (Date.now() - cached.cachedAt > TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return cached.listing;
}

export function setCachedDirectoryListing(key: string, listing: RemoteDirectoryListing): void {
  // Refresh insertion order so the oldest key is evicted first.
  cache.delete(key);
  cache.set(key, { listing, cachedAt: Date.now() });
  if (cache.size > MAX_KEYS) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
}

// Drops every cached listing whose key starts with `prefix` (a pane's
// `${connectionId}:${side}` request key). Mutating operations call this so
// the post-mutation reload never flashes the pre-mutation listing.
export function invalidateDirectoryListingCache(prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

// Test isolation: the cache is module-level, so without an explicit reset
// one test's listing would leak into the next test sharing a connection id.
export function clearDirectoryListingCache(): void {
  cache.clear();
}
