import React, { useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useSftpStore } from '@/stores/sftpStore';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { SplitPane } from '@/components/ui/SplitPane';
import { SftpPane } from './SftpPane';
import { SftpToolbar } from './SftpToolbar';
import { SftpTabBar } from './SftpTabBar';
import { SftpTabContextMenu } from './SftpTabContextMenu';
import { SftpNewConnectionMenu } from './SftpNewConnectionMenu';
import { PromptDialog, PermissionsDialog } from './SftpDialogs';
import { SftpDndContext, type SftpDndPayload } from './SftpDndContext';
import { TransferProgress } from './TransferProgress';
import { useSftpConnection } from '@/hooks/useSftpConnection';
import { useLocalDirectory } from '@/hooks/useLocalDirectory';
import {
  invokePickLocalFiles,
  invokePickLocalFolder,
} from '@/lib/tauri';

const Sftp: React.FC = () => {
  const { t } = useI18n();
  const connections = useSftpStore((state) => state.connections);
  const activeConnectionId = useSftpStore((state) => state.activeConnectionId);
  const connection = connections.find((c) => c.id === activeConnectionId);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [newConnectionMenuOpen, setNewConnectionMenuOpen] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<{
    connection: ReturnType<typeof useSftpStore.getState>['connections'][number];
    x: number;
    y: number;
  } | null>(null);

  if (!connection) {
    return (
      <div className="flex h-full flex-col">
        <SftpTabBar
          onNewTabClick={() => setNewConnectionMenuOpen(true)}
          onTabContextMenu={(conn, x, y) => setTabContextMenu({ connection: conn, x, y })}
        />
        <div className="relative min-h-0 flex-1">
          <div className="flex h-full items-center justify-center">
            <EmptyState
              title={t('sftp.empty')}
              description={t('sftp.empty.openFromWorkbench')}
              action={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setNewConnectionMenuOpen(true)}
                >
                  {t('sftp.empty.newConnection')}
                </Button>
              }
            />
          </div>
          <SftpNewConnectionMenu
            open={newConnectionMenuOpen}
            onClose={() => setNewConnectionMenuOpen(false)}
          />
        </div>
        <SftpTabContextMenu
          open={!!tabContextMenu}
          x={tabContextMenu?.x ?? 0}
          y={tabContextMenu?.y ?? 0}
          connection={tabContextMenu?.connection ?? null}
          onClose={() => setTabContextMenu(null)}
        />
      </div>
    );
  }

  return (
    <SftpContent
      connection={connection}
      newFolderOpen={newFolderOpen}
      setNewFolderOpen={setNewFolderOpen}
      renameOpen={renameOpen}
      setRenameOpen={setRenameOpen}
      permissionsOpen={permissionsOpen}
      setPermissionsOpen={setPermissionsOpen}
      newConnectionMenuOpen={newConnectionMenuOpen}
      setNewConnectionMenuOpen={setNewConnectionMenuOpen}
      tabContextMenu={tabContextMenu}
      setTabContextMenu={setTabContextMenu}
    />
  );
};

interface SftpContentProps {
  connection: ReturnType<typeof useSftpStore.getState>['connections'][number];
  newFolderOpen: boolean;
  setNewFolderOpen: (v: boolean) => void;
  renameOpen: boolean;
  setRenameOpen: (v: boolean) => void;
  permissionsOpen: boolean;
  setPermissionsOpen: (v: boolean) => void;
  newConnectionMenuOpen: boolean;
  setNewConnectionMenuOpen: (v: boolean) => void;
  tabContextMenu: {
    connection: ReturnType<typeof useSftpStore.getState>['connections'][number];
    x: number;
    y: number;
  } | null;
  setTabContextMenu: (
    value: {
      connection: ReturnType<typeof useSftpStore.getState>['connections'][number];
      x: number;
      y: number;
    } | null,
  ) => void;
}

const SftpContent: React.FC<SftpContentProps> = ({
  connection,
  newFolderOpen,
  setNewFolderOpen,
  renameOpen,
  setRenameOpen,
  permissionsOpen,
  setPermissionsOpen,
  newConnectionMenuOpen,
  setNewConnectionMenuOpen,
  tabContextMenu,
  setTabContextMenu,
}) => {
  const { t } = useI18n();
  const {
    createRemoteEntry,
    renameRemotePath,
    deleteRemotePaths,
    updateRemotePermissions,
    uploadLocalPaths,
    downloadRemotePaths,
    loadRemoteDirectory,
  } = useSftpConnection(connection);
  const { loadLocalDirectory } = useLocalDirectory(connection);

  const setPaneState = useSftpStore((state) => state.setPaneState);

  const selectedRemotePaths = new Set(connection.remotePane.selectedPaths);
  const selectedLocalPaths = new Set(connection.localPane.selectedPaths);

  const selectedRemote = Array.from(selectedRemotePaths);
  const selectedLocal = Array.from(selectedLocalPaths);

  const handleUpload = async (): Promise<void> => {
    const paths = await invokePickLocalFiles();
    if (paths.length === 0) return;
    await uploadLocalPaths(paths, connection.remotePath);
    await loadRemoteDirectory(connection.remotePath);
  };

  const handleDownload = async (): Promise<void> => {
    if (selectedRemote.length === 0) return;
    const folders = await invokePickLocalFolder();
    if (folders.length === 0) return;
    await downloadRemotePaths(selectedRemote, folders[0]);
    await loadLocalDirectory(connection.localPath);
  };

  const handleDelete = async (): Promise<void> => {
    if (selectedRemote.length === 0) return;
    await deleteRemotePaths(selectedRemote);
    setPaneState(connection.id, 'remote', { selectedPaths: [] });
  };

  const handleRename = async (newName: string): Promise<void> => {
    if (selectedRemote.length !== 1) return;
    await renameRemotePath(selectedRemote[0], newName);
    setPaneState(connection.id, 'remote', { selectedPaths: [] });
  };

  const handleCreateFolder = async (name: string): Promise<void> => {
    await createRemoteEntry(connection.remotePath, name, 'directory');
  };

  const handlePermissions = async (permissions: number): Promise<void> => {
    if (selectedRemote.length !== 1) return;
    await updateRemotePermissions(selectedRemote[0], permissions);
    setPaneState(connection.id, 'remote', { selectedPaths: [] });
  };

  const handleDragEnd = async (
    payload: SftpDndPayload,
    targetSide: 'local' | 'remote',
  ): Promise<void> => {
    const paths = payload.entries.map((entry) => entry.path);
    if (payload.side === 'local' && targetSide === 'remote') {
      await uploadLocalPaths(paths, connection.remotePath);
      await loadRemoteDirectory(connection.remotePath);
      setPaneState(connection.id, 'local', { selectedPaths: [] });
    } else if (payload.side === 'remote' && targetSide === 'local') {
      const folders = await invokePickLocalFolder();
      if (folders.length === 0) return;
      await downloadRemotePaths(paths, folders[0]);
      await loadLocalDirectory(connection.localPath);
      setPaneState(connection.id, 'remote', { selectedPaths: [] });
    }
  };

  return (
    <SftpDndContext onDragEnd={handleDragEnd}>
      <div className="flex h-full flex-col">
        <SftpTabBar
          onNewTabClick={() => setNewConnectionMenuOpen(true)}
          onTabContextMenu={(conn, x, y) => setTabContextMenu({ connection: conn, x, y })}
        />
        <SftpToolbar
          onNewFolder={() => setNewFolderOpen(true)}
          onUpload={handleUpload}
          onDownload={handleDownload}
          onDelete={handleDelete}
          onRename={() => setRenameOpen(true)}
          onPermissions={() => setPermissionsOpen(true)}
        />
        <div className="flex-1 min-h-0 p-2">
          <SplitPane
            left={
              <SftpPane
                connection={connection}
                side="local"
                selectedPaths={selectedLocalPaths}
                onSelectedPathsChange={(paths) =>
                  setPaneState(connection.id, 'local', { selectedPaths: Array.from(paths) })
                }
              />
            }
            right={
              <SftpPane
                connection={connection}
                side="remote"
                selectedPaths={selectedRemotePaths}
                onSelectedPathsChange={(paths) =>
                  setPaneState(connection.id, 'remote', { selectedPaths: Array.from(paths) })
                }
              />
            }
          />
        </div>

        <PromptDialog
          open={newFolderOpen}
          onClose={() => setNewFolderOpen(false)}
          onConfirm={handleCreateFolder}
          title={t('common.newFolder')}
          label={t('common.newFolder')}
          confirmText={t('common.create')}
        />

        <PromptDialog
          open={renameOpen}
          onClose={() => setRenameOpen(false)}
          onConfirm={handleRename}
          title={t('common.rename')}
          label={t('common.rename')}
          confirmText={t('common.save')}
          defaultValue={
            selectedRemote.length === 1
              ? selectedRemote[0].split('/').pop() ?? ''
              : ''
          }
        />

        <PermissionsDialog
          open={permissionsOpen}
          onClose={() => setPermissionsOpen(false)}
          onConfirm={handlePermissions}
        />
        <TransferProgress />
      </div>
      <SftpNewConnectionMenu
        open={newConnectionMenuOpen}
        onClose={() => setNewConnectionMenuOpen(false)}
      />
      <SftpTabContextMenu
        open={!!tabContextMenu}
        x={tabContextMenu?.x ?? 0}
        y={tabContextMenu?.y ?? 0}
        connection={tabContextMenu?.connection ?? null}
        onClose={() => setTabContextMenu(null)}
      />
    </SftpDndContext>
  );
};

export default Sftp;
