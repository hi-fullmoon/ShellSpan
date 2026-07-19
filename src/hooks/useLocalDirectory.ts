import { useCallback } from 'react';
import { invokeListLocalDirectory, invokeOpenPath } from '@/lib/tauri';
import { useSftpStore, type SftpConnection, type SftpSide } from '@/stores/sftpStore';

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
      setLoading(connection.id, side, true);
      setError(connection.id, side);
      try {
        const listing = await invokeListLocalDirectory(path ?? '');
        setPath(connection.id, side, listing.path);
        setEntries(connection.id, side, listing.entries);
      } catch (error) {
        setError(
          connection.id,
          side,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setLoading(connection.id, side, false);
      }
    },
    [connection.id, setPath, setEntries, setLoading, setError, side],
  );

  const openLocalPath = useCallback(async (path: string) => {
    await invokeOpenPath(path);
  }, []);

  return { loadLocalDirectory, openLocalPath };
}
