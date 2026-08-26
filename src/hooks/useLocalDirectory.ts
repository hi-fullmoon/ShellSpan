import { useCallback } from 'react';
import {
  invokeListLocalDirectory,
  invokeOpenPath,
  invokePreviewLocalFile,
  invokeSupersedeRemoteDirectoryRequest,
} from '@/lib/tauri';
import { getLocalizedErrorMessage } from '@/lib/error';
import { useSftpStore, type SftpConnection, type SftpSide } from '@/stores/sftpStore';
import {
  getBackendDirectoryListRequestKey,
  isLatestDirectoryListRequest,
  nextDirectoryListRequestId,
} from '@/hooks/utils';
import type { ReadRemoteFileResponse } from '@/types';

export function useLocalDirectory(connection: SftpConnection, side: SftpSide = 'local'): {
  loadLocalDirectory: (path?: string) => Promise<void>;
  openLocalPath: (path: string) => Promise<void>;
  previewLocalFile: (path: string) => Promise<ReadRemoteFileResponse>;
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
        // Local and remote loads share a generation. Advance the Rust-side
        // watermark first so switching this pane to local cancels an older
        // remote readdir/health-check/owner lookup before local I/O begins.
        await invokeSupersedeRemoteDirectoryRequest(
          getBackendDirectoryListRequestKey(requestKey),
          requestId,
        ).catch(() => undefined);
        if (!isLatest()) return;
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

  const previewLocalFile = useCallback(async (path: string) => {
    return invokePreviewLocalFile(path);
  }, []);

  return { loadLocalDirectory, openLocalPath, previewLocalFile };
}
