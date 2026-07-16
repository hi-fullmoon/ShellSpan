import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import { useSftpStore } from '@/stores/sftpStore';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { SplitPane } from '@/components/ui/split-pane';
import { SftpPane } from './sftp-pane';
import { SftpTabBar } from './sftp-tab-bar';
import { SftpTabContextMenu } from './sftp-tab-context-menu';
import { SftpNewConnectionMenu } from './sftp-new-connection-menu';
import { PromptDialog, PermissionsDialog } from './sftp-dialogs';
import { SftpPropertiesDialog } from './sftp-properties-dialog';
import { SftpPreviewDialog } from './sftp-preview-dialog';
import { SftpUploadConflictDialog } from './sftp-upload-conflict-dialog';
import { SftpDndContext, type SftpDndPayload } from './sftp-dnd-context';
import { TransferProgress } from './transfer-progress';
import { HostKeyDialog } from '@/components/terminal/host-key-dialog';
import { useSftpPaneActions, type PendingUploadConflict, type UploadConflictAction } from '@/hooks/useSftpPaneActions';
import { useLocalDirectory } from '@/hooks/useLocalDirectory';
import { useSftpConnection } from '@/hooks/useSftpConnection';
import { useSftpConnectionOpener } from '@/hooks/useSftpConnectionOpener';
import type { ConnectionProfile, RemoteFileEntry, UploadConflictPolicy } from '@/types';

const Sftp: React.FC = () => {
  const { t } = useI18n();
  const connections = useSftpStore((state) => state.connections);
  const activeConnectionId = useSftpStore((state) => state.activeConnectionId);
  const connection = connections.find((c) => c.id === activeConnectionId);
  const {
    open: openSftpConnection,
    verifyHostKey,
    hostKeyDialog,
    closeHostKeyDialog,
  } = useSftpConnectionOpener();

  const [newConnectionMenuOpen, setNewConnectionMenuOpen] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState<{
    connection: ReturnType<typeof useSftpStore.getState>['connections'][number];
    x: number;
    y: number;
  } | null>(null);

  const activeSection = useAppStore((state) => state.activeSection);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (activeSection !== 'sftp') return;
        event.preventDefault();
        setNewConnectionMenuOpen((prev) => !prev);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeSection]);

  if (!connection) {
    return (
      <div className="flex h-full flex-col bg-app-bg">
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
                  variant="default"
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
            onConnect={openSftpConnection}
          />
        </div>
        <SftpTabContextMenu
          open={!!tabContextMenu}
          x={tabContextMenu?.x ?? 0}
          y={tabContextMenu?.y ?? 0}
          connection={tabContextMenu?.connection ?? null}
          onClose={() => setTabContextMenu(null)}
        />
        <HostKeyDialog
          open={hostKeyDialog.open}
          onClose={closeHostKeyDialog}
          host={hostKeyDialog.host}
          port={hostKeyDialog.port}
          fingerprint={hostKeyDialog.fingerprint}
          mismatch={hostKeyDialog.mismatch}
          onTrust={hostKeyDialog.onTrust}
        />
      </div>
    );
  }

  return (
    <>
      <SftpContent
        connection={connection}
        newConnectionMenuOpen={newConnectionMenuOpen}
        setNewConnectionMenuOpen={setNewConnectionMenuOpen}
        tabContextMenu={tabContextMenu}
        setTabContextMenu={setTabContextMenu}
        openSftpConnection={openSftpConnection}
        verifyHostKey={verifyHostKey}
      />
      <HostKeyDialog
        open={hostKeyDialog.open}
        onClose={closeHostKeyDialog}
        host={hostKeyDialog.host}
        port={hostKeyDialog.port}
        fingerprint={hostKeyDialog.fingerprint}
        mismatch={hostKeyDialog.mismatch}
        onTrust={hostKeyDialog.onTrust}
      />
    </>
  );
};

interface SftpContentProps {
  connection: ReturnType<typeof useSftpStore.getState>['connections'][number];
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
  openSftpConnection: (profile: ConnectionProfile) => Promise<void>;
  verifyHostKey: (host: string, port: number, onVerified: () => void) => Promise<void>;
}

interface UploadQueue {
  paths: string[];
  destination: string;
  index: number;
  accepted: string[];
  policies: UploadConflictPolicy[];
  remembered: UploadConflictAction | undefined;
}

const SftpContent: React.FC<SftpContentProps> = ({
  connection,
  newConnectionMenuOpen,
  setNewConnectionMenuOpen,
  tabContextMenu,
  setTabContextMenu,
  openSftpConnection,
  verifyHostKey,
}) => {
  const { t } = useI18n();
  const localActions = useSftpPaneActions(connection, 'local');
  const remoteActions = useSftpPaneActions(connection, 'remote');
  const { loadLocalDirectory } = useLocalDirectory(connection);
  const { loadRemoteDirectory, downloadRemotePaths } = useSftpConnection(connection);
  const setPaneState = useSftpStore((state) => state.setPaneState);

  const selectedRemotePaths = new Set(connection.remotePane.selectedPaths);
  const selectedLocalPaths = new Set(connection.localPane.selectedPaths);

  const uploadQueueRef = useRef<UploadQueue | null>(null);
  const [uploadConflict, setUploadConflict] = useState<PendingUploadConflict | undefined>(undefined);

  const localPathName = (path: string): string => {
    const normalized = path.replace(/\\/g, '/');
    return normalized.split('/').filter(Boolean).pop() ?? path;
  };

  const processUploadQueue = React.useCallback(async () => {
    const queue = uploadQueueRef.current;
    if (!queue) return;

    const existingByName = new Map(
      connection.remoteEntries.map((entry) => [entry.name, entry]),
    );

    while (queue.index < queue.paths.length) {
      const path = queue.paths[queue.index];
      const name = localPathName(path);
      const existing = existingByName.get(name);

      if (!existing) {
        queue.accepted.push(path);
        queue.policies.push('fail');
        queue.index += 1;
        continue;
      }

      if (queue.remembered) {
        if (queue.remembered === 'overwrite') {
          queue.accepted.push(path);
          queue.policies.push('overwrite');
        }
        queue.index += 1;
        continue;
      }

      const remainingConflicts = queue.paths
        .slice(queue.index + 1)
        .reduce(
          (count, remainingPath) =>
            count + (existingByName.has(localPathName(remainingPath)) ? 1 : 0),
          0,
        );

      setUploadConflict({
        localPath: path,
        targetName: name,
        existingKind: existing.kind,
        remainingConflicts,
      });
      return;
    }

    if (queue.accepted.length > 0) {
      await remoteActions.uploadWithPolicies(
        queue.accepted,
        queue.destination,
        queue.policies,
      );
    }

    uploadQueueRef.current = null;
    setUploadConflict(undefined);
  }, [connection.remoteEntries, remoteActions]);

  const handleUploadConflictResolution = async (
    action: UploadConflictAction,
    applyToRemaining: boolean,
  ): Promise<void> => {
    const queue = uploadQueueRef.current;
    if (!queue) return;

    if (action === 'cancel') {
      uploadQueueRef.current = null;
      setUploadConflict(undefined);
      return;
    }

    if (applyToRemaining) {
      queue.remembered = action;
    }

    if (action === 'overwrite') {
      queue.accepted.push(queue.paths[queue.index]);
      queue.policies.push('overwrite');
    }

    queue.index += 1;
    setUploadConflict(undefined);
    await processUploadQueue();
  };

  const handleDragEnd = async (
    payload: SftpDndPayload,
    targetSide: 'local' | 'remote',
  ): Promise<void> => {
    const paths = payload.entries.map((entry) => entry.path);
    if (payload.side === 'local' && targetSide === 'remote') {
      uploadQueueRef.current = {
        paths,
        destination: connection.remotePath,
        index: 0,
        accepted: [],
        policies: [],
        remembered: undefined,
      };
      await processUploadQueue();
      await loadRemoteDirectory(connection.remotePath);
      setPaneState(connection.id, 'local', { selectedPaths: [] });
    } else if (payload.side === 'remote' && targetSide === 'local') {
      await downloadRemotePaths(paths, connection.localPath);
      await loadLocalDirectory(connection.localPath);
      setPaneState(connection.id, 'remote', { selectedPaths: [] });
    }
  };

  return (
    <SftpDndContext onDragEnd={handleDragEnd}>
      <div className="flex h-full flex-col bg-app-bg">
        <SftpTabBar
          onNewTabClick={() => setNewConnectionMenuOpen(true)}
          onTabContextMenu={(conn, x, y) => setTabContextMenu({ connection: conn, x, y })}
        />
        <div className="flex-1 min-h-0">
          <SplitPane
            left={
              <SftpPane
                connection={connection}
                side="local"
                actions={localActions}
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
                actions={remoteActions}
                selectedPaths={selectedRemotePaths}
                onSelectedPathsChange={(paths) =>
                  setPaneState(connection.id, 'remote', { selectedPaths: Array.from(paths) })
                }
                onVerifyHostKey={() => {
                  void verifyHostKey(
                    connection.connection.host,
                    connection.connection.port,
                    () => void loadRemoteDirectory(connection.remotePath),
                  );
                }}
              />
            }
          />
        </div>

        <PromptDialog
          open={localActions.createMode === 'folder'}
          onClose={() => localActions.setCreateMode(null)}
          onConfirm={(value) => {
            if (value.trim()) localActions.handleCreate(value.trim(), 'directory');
          }}
          title={t('common.newFolder')}
          label={t('common.newFolder')}
          confirmText={t('common.create')}
        />

        <PromptDialog
          open={remoteActions.createMode === 'folder'}
          onClose={() => remoteActions.setCreateMode(null)}
          onConfirm={(value) => {
            if (value.trim()) remoteActions.handleCreate(value.trim(), 'directory');
          }}
          title={t('common.newFolder')}
          label={t('common.newFolder')}
          confirmText={t('common.create')}
        />

        <PromptDialog
          open={remoteActions.createMode === 'file'}
          onClose={() => remoteActions.setCreateMode(null)}
          onConfirm={(value) => {
            if (value.trim()) remoteActions.handleCreate(value.trim(), 'file');
          }}
          title={t('sftp.contextMenu.newFile')}
          label={t('common.name')}
          confirmText={t('common.create')}
        />

        <PromptDialog
          open={localActions.renameTarget !== undefined}
          onClose={() => localActions.setRenameTarget(undefined)}
          onConfirm={localActions.handleRename}
          title={t('common.rename')}
          label={t('common.rename')}
          confirmText={t('common.save')}
          defaultValue={localActions.renameTarget?.name}
        />

        <PromptDialog
          open={remoteActions.renameTarget !== undefined}
          onClose={() => remoteActions.setRenameTarget(undefined)}
          onConfirm={remoteActions.handleRename}
          title={t('common.rename')}
          label={t('common.rename')}
          confirmText={t('common.save')}
          defaultValue={remoteActions.renameTarget?.name}
        />

        <PermissionsDialog
          open={localActions.permissionsTarget !== undefined}
          onClose={() => localActions.setPermissionsTarget(undefined)}
          onConfirm={localActions.handlePermissions}
          defaultValue={localActions.permissionsTarget?.permissions}
        />

        <PermissionsDialog
          open={remoteActions.permissionsTarget !== undefined}
          onClose={() => remoteActions.setPermissionsTarget(undefined)}
          onConfirm={remoteActions.handlePermissions}
          defaultValue={remoteActions.permissionsTarget?.permissions}
        />

        <SftpPropertiesDialog
          entry={localActions.propertiesTarget}
          open={localActions.propertiesTarget !== undefined}
          onClose={() => localActions.setPropertiesTarget(undefined)}
        />

        <SftpPropertiesDialog
          entry={remoteActions.propertiesTarget}
          open={remoteActions.propertiesTarget !== undefined}
          onClose={() => remoteActions.setPropertiesTarget(undefined)}
        />

        <SftpPreviewDialog
          content={remoteActions.previewContent}
          open={remoteActions.previewContent !== undefined}
          onClose={() => remoteActions.setPreviewContent(undefined)}
        />

        <SftpUploadConflictDialog
          conflict={uploadConflict}
          open={uploadConflict !== undefined}
          onClose={() => setUploadConflict(undefined)}
          onResolve={(action, applyToRemaining) => {
            void handleUploadConflictResolution(action, applyToRemaining);
          }}
        />

        <TransferProgress />
      </div>
      <SftpNewConnectionMenu
        open={newConnectionMenuOpen}
        onClose={() => setNewConnectionMenuOpen(false)}
        onConnect={openSftpConnection}
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
