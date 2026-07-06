import { useCallback } from 'react';
import { invokeListLocalDirectory, invokeOpenPath } from '@/lib/tauri';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';

export function useLocalDirectory(connection: SftpConnection): {
  loadLocalDirectory: (path?: string) => Promise<void>;
  openLocalPath: (path: string) => Promise<void>;
} {
  const setPath = useSftpStore((state) => state.setPath);
  const setEntries = useSftpStore((state) => state.setEntries);
  const setLoading = useSftpStore((state) => state.setLoading);
  const setError = useSftpStore((state) => state.setError);

  const loadLocalDirectory = useCallback(
    async (path?: string) => {
      setLoading(connection.id, 'local', true);
      setError(connection.id, 'local');
      try {
        const listing = await invokeListLocalDirectory(path ?? '');
        setPath(connection.id, 'local', listing.path);
        setEntries(connection.id, 'local', listing.entries);
      } catch (error) {
        setError(
          connection.id,
          'local',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setLoading(connection.id, 'local', false);
      }
    },
    [connection.id, setPath, setEntries, setLoading, setError],
  );

  const openLocalPath = useCallback(async (path: string) => {
    await invokeOpenPath(path);
  }, []);

  return { loadLocalDirectory, openLocalPath };
}
