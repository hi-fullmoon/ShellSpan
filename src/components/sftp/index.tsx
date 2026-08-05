import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderIcon, ServerIcon } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import { useAppStore } from '@/stores/appStore';
import {
  getSftpPaneConnection,
  getSftpPaneConnectionKey,
  getSftpPaneSource,
  useSftpStore,
  type SftpSide,
} from '@/stores/sftpStore';
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
import { useSystemFileDrop } from '@/hooks/useSystemFileDrop';
import { useToast } from '@/hooks/useToast';
import { invokeCancelRemoteCopy, invokeCopyRemoteToRemote } from '@/lib/tauri';
import { getLocalizedErrorMessage } from '@/lib/error';
import { normalizePortablePath, parentPortablePath } from '@/lib/path-utils';
import { useTransferStore } from '@/stores/transferStore';
import type { ConnectionProfile, UploadConflictPolicy } from '@/types';

const Sftp: React.FC = () => {
  const { t } = useI18n();
  const connections = useSftpStore((state) => state.connections);
  const activeConnectionId = useSftpStore((state) => state.activeConnectionId);
  const connection = connections.find((c) => c.id === activeConnectionId);
  const addLocalConnection = useSftpStore((state) => state.addLocalConnection);
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

  useEffect(() => {
    const handleNewConnectionRequest = (): void => setNewConnectionMenuOpen((prev) => !prev);
    document.addEventListener('termbridge:new-sftp-connection', handleNewConnectionRequest);
    return () => document.removeEventListener('termbridge:new-sftp-connection', handleNewConnectionRequest);
  }, []);

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
            onOpenLocal={addLocalConnection}
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
  openSftpConnection: (profile: ConnectionProfile, targetConnectionId?: string, targetSide?: SftpSide) => Promise<void>;
  verifyHostKey: (host: string, port: number, onVerified: () => void) => Promise<void>;
}

interface UploadQueue {
  paths: string[];
  destination: string;
  side: 'local' | 'remote';
  index: number;
  accepted: string[];
  policies: UploadConflictPolicy[];
  remembered: UploadConflictAction | undefined;
  sourceSide?: SftpSide;
  sourceLocal: boolean;
}

export const SftpContent: React.FC<SftpContentProps> = ({
  connection,
  newConnectionMenuOpen,
  setNewConnectionMenuOpen,
  tabContextMenu,
  setTabContextMenu,
  openSftpConnection,
  verifyHostKey,
}) => {
  const { t } = useI18n();
  const leftSource = getSftpPaneSource(connection, 'local');
  const rightSource = getSftpPaneSource(connection, 'remote');
  const leftIsLocal = leftSource === 'local';
  const rightIsLocal = rightSource === 'local';
  const localActions = useSftpPaneActions(connection, 'local', leftIsLocal);
  const remoteActions = useSftpPaneActions(connection, 'remote', rightIsLocal);
  const { loadLocalDirectory } = useLocalDirectory(connection, 'local');
  const { loadLocalDirectory: loadRightLocalDirectory } = useLocalDirectory(connection, 'remote');
  const leftRemote = useSftpConnection(connection, 'local');
  const rightRemote = useSftpConnection(connection, 'remote');
  const { error } = useToast();
  const setPaneState = useSftpStore((state) => state.setPaneState);
  const setPaneLocal = useSftpStore((state) => state.setPaneLocal);
  const setSplitRatio = useSftpStore((state) => state.setSplitRatio);
  const addLocalConnection = useSftpStore((state) => state.addLocalConnection);
  const addTransferOperation = useTransferStore((state) => state.addOperation);
  const markTransferRunning = useTransferStore((state) => state.markOperationRunning);
  const markTransferCompleted = useTransferStore((state) => state.markOperationCompleted);
  const markTransferFailed = useTransferStore((state) => state.markOperationFailed);
  const markTransferCancelled = useTransferStore((state) => state.markOperationCancelled);

  const selectedRemotePaths = useMemo(
    () => new Set(connection.remotePane.selectedPaths),
    [connection.remotePane.selectedPaths],
  );
  const selectedLocalPaths = useMemo(
    () => new Set(connection.localPane.selectedPaths),
    [connection.localPane.selectedPaths],
  );

  const uploadQueueRef = useRef<UploadQueue | null>(null);
  const [uploadConflict, setUploadConflict] = useState<PendingUploadConflict | undefined>(undefined);
  const [sourceTargetSide, setSourceTargetSide] = useState<SftpSide | null>(null);

  const leftPaneRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);

  const localPathName = (path: string): string => {
    const normalized = path.replace(/\\/g, '/');
    return normalized.split('/').filter(Boolean).pop() ?? path;
  };

  const localPathsEqual = (left: string, right: string): boolean => {
    const normalize = (value: string): string => {
      let normalized = normalizePortablePath(value);
      while (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
      }
      return /^[A-Za-z]:/.test(normalized) || normalized.startsWith('//')
        ? normalized.toLowerCase()
        : normalized;
    };
    return normalize(left) === normalize(right);
  };

  const remoteDestinationPath = (directory: string, sourcePath: string): string => {
    const base = directory === '/' ? '' : directory.replace(/\/+$/, '');
    return `${base}/${localPathName(sourcePath)}`;
  };

  const processUploadQueue = React.useCallback(async () => {
    const queue = uploadQueueRef.current;
    if (!queue) return;

    while (queue.index < queue.paths.length) {
      // Read the latest entries on every conflict check: a refresh landing
      // while the queue waits on a conflict dialog must not be judged against
      // the snapshot taken when the queue started.
      const latestConnection = useSftpStore
        .getState()
        .connections.find((candidate) => candidate.id === connection.id);
      const latestEntries =
        (queue.side === 'local' ? latestConnection?.localEntries : latestConnection?.remoteEntries) ?? [];
      const existingByName = new Map(latestEntries.map((entry) => [entry.name, entry]));
      // Names claimed earlier in this batch are not in the listing yet, but
      // they will be once the upload runs. Count them as conflicts too,
      // otherwise a second same-name file would be dispatched with a 'fail'
      // policy and silently never arrive.
      for (const acceptedPath of queue.accepted) {
        const acceptedName = localPathName(acceptedPath);
        if (!existingByName.has(acceptedName)) {
          existingByName.set(acceptedName, { path: acceptedPath, name: acceptedName, kind: 'file' });
        }
      }

      const path = queue.paths[queue.index];
      const name = localPathName(path);
      const targetLocal = queue.side === 'local' ? leftIsLocal : rightIsLocal;

      // Finder/Explorer can report a system drop back onto the directory the
      // item already belongs to. Ignore it before presenting a false conflict.
      if (
        targetLocal &&
        queue.sourceLocal &&
        localPathsEqual(parentPortablePath(path), queue.destination)
      ) {
        queue.index += 1;
        continue;
      }

      const existing = existingByName.get(name);

      if (!existing) {
        queue.accepted.push(path);
        queue.policies.push('fail');
        queue.index += 1;
        continue;
      }

      const defaultConflictPolicy = useAppStore.getState().sftpConflictPolicy;
      if (defaultConflictPolicy !== 'ask') {
        if (defaultConflictPolicy === 'overwrite') {
          queue.accepted.push(path);
          queue.policies.push('overwrite');
        }
        queue.index += 1;
        continue;
      }

      if (queue.remembered) {
        if (
          queue.remembered === 'overwrite' ||
          queue.remembered === 'replace'
        ) {
          queue.accepted.push(path);
          queue.policies.push(queue.remembered);
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

    try {
      if (queue.accepted.length > 0) {
        const targetLocal = queue.side === 'local' ? leftIsLocal : rightIsLocal;
        if (targetLocal && queue.sourceLocal) {
          const targetActions = queue.side === 'local' ? localActions : remoteActions;
          await targetActions.copyWithPolicies(
            queue.accepted,
            queue.destination,
            queue.policies,
          );
        } else if (targetLocal && queue.sourceSide) {
          const sourceRemote = queue.sourceSide === 'local' ? leftRemote : rightRemote;
          await sourceRemote.downloadRemotePaths(queue.accepted, queue.destination, undefined, queue.policies);
        } else if (queue.sourceLocal) {
          const targetActions = queue.side === 'local' ? localActions : remoteActions;
          await targetActions.uploadWithPolicies(
            queue.accepted,
            queue.destination,
            queue.policies,
          );
        } else if (queue.sourceSide) {
          const sourceConnectionKey = getSftpPaneConnectionKey(connection, queue.sourceSide);
          const destinationConnectionKey = getSftpPaneConnectionKey(connection, queue.side);
          const operationId = `${connection.id}-remote-copy-${crypto.randomUUID()}`;
          const request = {
            sourceConnection: getSftpPaneConnection(connection, queue.sourceSide),
            destinationConnection: getSftpPaneConnection(connection, queue.side),
            sourcePaths: queue.accepted,
            destinationDirectory: queue.destination,
            conflictPolicies: queue.policies,
            operationId,
          };
          const targetRemote = queue.side === 'local' ? leftRemote : rightRemote;
          const runRemoteCopy = async (): Promise<void> => {
            markTransferRunning(operationId);
            try {
              await invokeCopyRemoteToRemote(request);
              markTransferCompleted(operationId);
              void targetRemote.loadRemoteDirectory(queue.destination);
            } catch (copyError) {
              const operation = useTransferStore.getState().operations.find(
                (item) => item.operationId === operationId,
              );
              if (operation?.status === 'cancelling') {
                markTransferCancelled(operationId);
                return;
              }
              markTransferFailed(
                operationId,
                getLocalizedErrorMessage(copyError),
              );
              throw copyError;
            }
          };
          addTransferOperation({
            operationId,
            kind: 'remote-copy',
            connectionId: sourceConnectionKey,
            paths: queue.accepted,
            pathScopes: [
              { connectionId: sourceConnectionKey, paths: queue.accepted },
              {
                connectionId: destinationConnectionKey,
                paths: queue.accepted.map((path) =>
                  remoteDestinationPath(queue.destination, path),
                ),
              },
            ],
            currentPath: queue.accepted[0],
            totalBytes: 0,
            processedBytes: 0,
            totalSteps: queue.accepted.length,
            completedSteps: 0,
            status: 'running',
            retry: runRemoteCopy,
            cancel: () => invokeCancelRemoteCopy(operationId),
          });
          try {
            await runRemoteCopy();
          } catch {
            // The task row keeps the failure and retry action visible.
          }
        }
      }
    } catch {
      // The remote-to-local download branch rethrows on failure (unlike the
      // other branches, which report through the transfer store). Surface it
      // here so the rejection is never unhandled; the finally block below
      // still releases the queue so later drops are not blocked forever.
      error(t('sftp.transfer.downloadFailed'));
    } finally {
      uploadQueueRef.current = null;
      setUploadConflict(undefined);
    }
  }, [addTransferOperation, connection, error, leftIsLocal, leftRemote, localActions, markTransferCancelled, markTransferCompleted, markTransferFailed, markTransferRunning, remoteActions, rightIsLocal, rightRemote, t]);

  const refreshAfterQueue = useCallback(
    async (side: 'local' | 'remote') => {
      const source = side === 'local' ? leftSource : rightSource;
      const path = side === 'local' ? connection.localPath : connection.remotePath;
      if (source === 'local') {
        await (side === 'local' ? loadLocalDirectory(path) : loadRightLocalDirectory(path));
      } else {
        await (side === 'local'
          ? leftRemote.loadRemoteDirectory(path)
          : rightRemote.loadRemoteDirectory(path));
      }
      setPaneState(connection.id, side, { selectedPaths: [] });
    },
    [connection.id, connection.localPath, connection.remotePath, leftRemote, leftSource, loadLocalDirectory, loadRightLocalDirectory, rightRemote, rightSource, setPaneState],
  );

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

    if (action === 'overwrite' || action === 'replace') {
      queue.accepted.push(queue.paths[queue.index]);
      queue.policies.push(action);
    }

    queue.index += 1;
    setUploadConflict(undefined);
    await processUploadQueue();
    if (!uploadQueueRef.current) {
      await refreshAfterQueue(queue.side);
    }
  };

  const handleDragEnd = async (
    payload: SftpDndPayload,
    targetSide: 'local' | 'remote',
  ): Promise<void> => {
    if (payload.side === targetSide) return;
    if (uploadQueueRef.current) {
      error(t('sftp.transfer.pathBusy'));
      return;
    }
    const paths = payload.entries.map((entry) => entry.path);
    const sourceLocal = payload.side === 'local' ? leftIsLocal : rightIsLocal;
    uploadQueueRef.current = {
      paths,
      destination: targetSide === 'local' ? connection.localPath : connection.remotePath,
      side: targetSide,
      sourceSide: payload.side,
      sourceLocal,
      index: 0,
      accepted: [],
      policies: [],
      remembered: undefined,
    };
    await processUploadQueue();
    setPaneState(connection.id, payload.side, { selectedPaths: [] });
    if (!uploadQueueRef.current) {
      await refreshAfterQueue(targetSide);
    }
  };

  const canSystemDrop = useCallback((side: 'local' | 'remote') => {
    const isLocal = side === 'local';
    const loading = isLocal ? connection.localLoading : connection.remoteLoading;
    const panePath = isLocal ? connection.localPath : connection.remotePath;
    return !uploadQueueRef.current && !loading && Boolean(panePath);
  }, [connection.localLoading, connection.localPath, connection.remoteLoading, connection.remotePath, uploadConflict]);

  const handleSystemDrop = useCallback(
    async (paths: string[], side: 'local' | 'remote') => {
      if (uploadQueueRef.current) return;
      const destination = side === 'local' ? connection.localPath : connection.remotePath;
      if (!destination) return;
      uploadQueueRef.current = {
        paths,
        destination,
        side,
        sourceLocal: true,
        index: 0,
        accepted: [],
        policies: [],
        remembered: undefined,
      };
      await processUploadQueue();
      if (!uploadQueueRef.current) {
        await refreshAfterQueue(side);
      }
    },
    [connection.id, connection.localPath, connection.remotePath, refreshAfterQueue, processUploadQueue],
  );

  const handleSystemDropRejected = useCallback(
    (side: 'local' | 'remote') => {
      const label = side === 'local' ? t('sftp.local') : t('sftp.remote');
      error(t('sftp.drop.rejected', { side: label }));
    },
    [error, t],
  );

  const { dragActive: systemDragActive, hoveredSide: systemHoveredSide } = useSystemFileDrop({
    leftPaneRef,
    rightPaneRef,
    onDrop: handleSystemDrop,
    onDropRejected: handleSystemDropRejected,
    canDrop: canSystemDrop,
  });

  return (
    <SftpDndContext onDragEnd={handleDragEnd}>
      <div className="flex h-full flex-col bg-app-bg">
        <SftpTabBar
          onNewTabClick={() => {
            setSourceTargetSide(null);
            setNewConnectionMenuOpen(true);
          }}
          onTabContextMenu={(conn, x, y) => setTabContextMenu({ connection: conn, x, y })}
        />
        <div className="flex-1 min-h-0">
          <SplitPane
            minWidth={500}
            split={connection.splitRatio}
            onSplitChange={(ratio) => setSplitRatio(connection.id, ratio)}
            left={
              <SftpPane
                ref={leftPaneRef}
                connection={connection}
                side="local"
                actions={localActions}
                selectedPaths={selectedLocalPaths}
                onSelectedPathsChange={(paths) =>
                  setPaneState(connection.id, 'local', { selectedPaths: Array.from(paths) })
                }
                systemDropActive={systemDragActive}
                systemDropHovered={systemHoveredSide === 'local'}
                localMode={leftIsLocal}
                onTitleClick={() => {
                  setSourceTargetSide('local');
                  setNewConnectionMenuOpen(true);
                }}
                onVerifyHostKey={() => {
                  const request = getSftpPaneConnection(connection, 'local');
                  void verifyHostKey(
                    request.host,
                    request.port,
                    () => void leftRemote.loadRemoteDirectory(connection.localPath),
                  );
                }}
              />
            }
            right={rightSource === 'empty' ? (
              <div className="flex h-full flex-col items-center justify-center gap-4 bg-app-surface p-8 text-center">
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-semibold text-app-text">{t('sftp.source.emptyTitle')}</p>
                  <p className="max-w-xs text-xs text-app-text-soft">{t('sftp.source.emptyDescription')}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setPaneLocal(connection.id, 'remote')}>
                    <FolderIcon data-icon="inline-start" />
                    {t('sftp.source.local')}
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => {
                      setSourceTargetSide('remote');
                      setNewConnectionMenuOpen(true);
                    }}
                  >
                    <ServerIcon data-icon="inline-start" />
                    {t('sftp.source.remote')}
                  </Button>
                </div>
              </div>
            ) : (
              <SftpPane
                ref={rightPaneRef}
                connection={connection}
                side="remote"
                actions={remoteActions}
                selectedPaths={selectedRemotePaths}
                onSelectedPathsChange={(paths) =>
                  setPaneState(connection.id, 'remote', { selectedPaths: Array.from(paths) })
                }
                onVerifyHostKey={() => {
                  const request = getSftpPaneConnection(connection, 'remote');
                  void verifyHostKey(
                    request.host,
                    request.port,
                    () => void rightRemote.loadRemoteDirectory(connection.remotePath),
                  );
                }}
                systemDropActive={systemDragActive}
                systemDropHovered={systemHoveredSide === 'remote'}
                localMode={rightIsLocal}
                onTitleClick={() => {
                  setSourceTargetSide('remote');
                  setNewConnectionMenuOpen(true);
                }}
              />
            )}
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
          onClose={() => {
            uploadQueueRef.current = null;
            setUploadConflict(undefined);
          }}
          onResolve={(action, applyToRemaining) => {
            void handleUploadConflictResolution(action, applyToRemaining);
          }}
        />

        <TransferProgress />
      </div>
      <SftpNewConnectionMenu
        open={newConnectionMenuOpen}
        onClose={() => {
          setNewConnectionMenuOpen(false);
          setSourceTargetSide(null);
        }}
        onConnect={(profile) =>
          openSftpConnection(
            profile,
            sourceTargetSide ? connection.id : undefined,
            sourceTargetSide ?? 'remote',
          )
        }
        onOpenLocal={() => {
          if (sourceTargetSide) {
            setPaneLocal(connection.id, sourceTargetSide);
          } else {
            addLocalConnection();
          }
        }}
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
