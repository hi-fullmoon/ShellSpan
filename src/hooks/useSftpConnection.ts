import { useCallback } from 'react';
import {
  invokeCreateRemoteEntry,
  invokeDeleteRemotePath,
  invokeDownloadRemotePaths,
  invokeListRemoteDirectory,
  invokeRenameRemotePath,
  invokeUpdateRemotePermissions,
  invokeUploadLocalPaths,
} from '@/lib/tauri';
import { useSftpStore, type SftpConnection } from '@/stores/sftpStore';
import { useTransferStore } from '@/stores/transferStore';
import type { SftpSide } from '@/stores/sftpStore';

export function useSftpConnection(connection: SftpConnection): {
  loadRemoteDirectory: (path?: string) => Promise<void>;
  createRemoteEntry: (parentPath: string, name: string, kind: 'file' | 'directory') => Promise<void>;
  renameRemotePath: (path: string, newName: string) => Promise<void>;
  deleteRemotePaths: (paths: string[]) => Promise<void>;
  updateRemotePermissions: (path: string, permissions: number) => Promise<void>;
  uploadLocalPaths: (localPaths: string[], destinationDirectory: string, operationId?: string) => Promise<void>;
  downloadRemotePaths: (remotePaths: string[], destinationDirectory: string, operationId?: string) => Promise<void>;
} {
  const setPath = useSftpStore((state) => state.setPath);
  const setEntries = useSftpStore((state) => state.setEntries);
  const setLoading = useSftpStore((state) => state.setLoading);
  const setError = useSftpStore((state) => state.setError);
  const addOperation = useTransferStore((state) => state.addOperation);

  const loadRemoteDirectory = useCallback(
    async (path?: string) => {
      setLoading(connection.id, 'remote', true);
      setError(connection.id, 'remote');
      try {
        const listing = await invokeListRemoteDirectory({
          ...connection.connection,
          path,
        });
        setPath(connection.id, 'remote', listing.path);
        setEntries(connection.id, 'remote', listing.entries);
      } catch (error) {
        setError(
          connection.id,
          'remote',
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setLoading(connection.id, 'remote', false);
      }
    },
    [connection.id, connection.connection, setPath, setEntries, setLoading, setError],
  );

  const createRemoteEntry = useCallback(
    async (parentPath: string, name: string, kind: 'file' | 'directory') => {
      await invokeCreateRemoteEntry({
        ...connection.connection,
        parentPath,
        name,
        kind,
      });
      await loadRemoteDirectory(connection.remotePath);
    },
    [connection.connection, connection.remotePath, loadRemoteDirectory],
  );

  const renameRemotePath = useCallback(
    async (path: string, newName: string) => {
      await invokeRenameRemotePath({
        ...connection.connection,
        path,
        newName,
      });
      await loadRemoteDirectory(connection.remotePath);
    },
    [connection.connection, connection.remotePath, loadRemoteDirectory],
  );

  const deleteRemotePaths = useCallback(
    async (paths: string[]) => {
      const operationId = `${connection.id}-delete-${Date.now()}`;
      addOperation({
        operationId,
        kind: 'delete',
        currentPath: paths[0],
        totalBytes: 0,
        processedBytes: 0,
        totalSteps: paths.length,
        completedSteps: 0,
      });
      for (const path of paths) {
        await invokeDeleteRemotePath({
          ...connection.connection,
          path,
          operationId,
        });
      }
      await loadRemoteDirectory(connection.remotePath);
    },
    [connection.connection, connection.id, connection.remotePath, loadRemoteDirectory, addOperation],
  );

  const updateRemotePermissions = useCallback(
    async (path: string, permissions: number) => {
      await invokeUpdateRemotePermissions({
        ...connection.connection,
        path,
        permissions,
      });
      await loadRemoteDirectory(connection.remotePath);
    },
    [connection.connection, connection.remotePath, loadRemoteDirectory],
  );

  const uploadLocalPaths = useCallback(
    async (localPaths: string[], destinationDirectory: string, operationId = `${connection.id}-upload-${Date.now()}`) => {
      addOperation({
        operationId,
        kind: 'upload',
        currentPath: localPaths[0],
        totalBytes: 0,
        processedBytes: 0,
        totalSteps: localPaths.length,
        completedSteps: 0,
      });
      await invokeUploadLocalPaths({
        ...connection.connection,
        destinationDirectory,
        localPaths,
        conflictPolicies: [],
        operationId,
      });
      await loadRemoteDirectory(connection.remotePath);
    },
    [connection.connection, connection.id, connection.remotePath, loadRemoteDirectory, addOperation],
  );

  const downloadRemotePaths = useCallback(
    async (remotePaths: string[], destinationDirectory: string, operationId = `${connection.id}-download-${Date.now()}`) => {
      addOperation({
        operationId,
        kind: 'download',
        currentPath: remotePaths[0],
        totalBytes: 0,
        processedBytes: 0,
        totalSteps: remotePaths.length,
        completedSteps: 0,
      });
      await invokeDownloadRemotePaths({
        ...connection.connection,
        remotePaths,
        destinationDirectory,
        operationId,
      });
    },
    [connection.connection, connection.id, addOperation],
  );

  return {
    loadRemoteDirectory,
    createRemoteEntry,
    renameRemotePath,
    deleteRemotePaths,
    updateRemotePermissions,
    uploadLocalPaths,
    downloadRemotePaths,
  };
}
