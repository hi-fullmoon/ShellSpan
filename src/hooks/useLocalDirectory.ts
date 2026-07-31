import { useCallback } from 'react';
import { invokeListLocalDirectory, invokeOpenPath } from '@/lib/tauri';
import { getLocalizedErrorMessage } from '@/lib/error';
import { useSftpStore, type SftpConnection, type SftpSide } from '@/stores/sftpStore';

// Per-pane monotonically increasing request ids for directory listings. Only
// the latest request is allowed to write results back or clear the loading
// flag, so a slow stale response cannot clobber a newer listing.
const directoryListRequestIds = new Map<string, number>();

function nextDirectoryListRequestId(key: string): number {
  const next = (directoryListRequestIds.get(key) ?? 0) + 1;
  directoryListRequestIds.set(key, next);
  return next;
}

function isLatestDirectoryListRequest(key: string, requestId: number): boolean {
  return directoryListRequestIds.get(key) === requestId;
}

export function useLocalDirectory(connection: SftpConnection, side: SftpSide = 'local'): {
  loadLocalDirectory: (path?: string) => Promise<void>;
  openLocalPath: (path: string) => Promise<void>;
} {
  const setPath = useSftpStore((state) => state.setPath);
  const setEntries = useSftpStore((state) => state.setEntries);
  const setLoading = useSftpStore((state) => state.setLoading);
  const setError = useSftpStore((state) => state.setError);

  const loadLocalDirectory = useCallback(
    async (path?: string) => {
      const requestKey = `${connection.id}:${side}`;
      const requestId = nextDirectoryListRequestId(requestKey);
      const isLatest = () => isLatestDirectoryListRequest(requestKey, requestId);
      setLoading(connection.id, side, true);
      setError(connection.id, side);
      try {
        const listing = await invokeListLocalDirectory(path ?? '');
        if (!isLatest()) return;
        setPath(connection.id, side, listing.path);
        setEntries(connection.id, side, listing.entries);
      } catch (error) {
        if (!isLatest()) return;
        setError(
          connection.id,
          side,
          getLocalizedErrorMessage(error),
        );
      } finally {
        if (isLatest()) {
          setLoading(connection.id, side, false);
        }
      }
    },
    [connection.id, setPath, setEntries, setLoading, setError, side],
  );

  const openLocalPath = useCallback(async (path: string) => {
    await invokeOpenPath(path);
  }, []);

  return { loadLocalDirectory, openLocalPath };
}
