// Per-pane monotonically increasing request ids for directory listings. Only
// the latest request is allowed to write results back or clear the loading
// flag, so a slow stale response cannot clobber a newer listing.
//
// This counter is shared by local and remote directory loads on purpose: both
// hooks key requests by `${connection.id}:${side}`, so when a pane switches
// source (remote -> local or vice versa) the new listing invalidates any
// in-flight request from the previous source.
const directoryListRequestIds = new Map<string, number>();

export function nextDirectoryListRequestId(key: string): number {
  const next = (directoryListRequestIds.get(key) ?? 0) + 1;
  directoryListRequestIds.set(key, next);
  return next;
}

export function isLatestDirectoryListRequest(key: string, requestId: number): boolean {
  return directoryListRequestIds.get(key) === requestId;
}
