import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useToast } from '@/hooks/useToast';
import { useProfileStore } from '@/stores/profileStore';
import { useAppStore } from '@/stores/appStore';
import { ConnectionFormDrawer } from './connection-form-drawer';
import { ConnectionList } from './connection-list';
import { KnownHostsPanel } from './known-hosts-panel';
import { KeychainPanel } from './keychain-panel';
import { LogPanel } from './log-panel';
import { MonitorPanel } from './monitor-panel';
import { WorkbenchSidebar } from './workbench-sidebar';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { HostKeyDialog } from '@/components/terminal/host-key-dialog';
import type { ConnectionProfile } from '@/types';
import { useConnectSession } from '@/hooks/useConnectSession';
import { useSftpConnectionOpener } from '@/hooks/useSftpConnectionOpener';
import { ConnectionImportDialog } from './connection-import-dialog';
import {
  buildConnectionImportPreview,
  exportConnections,
  importConnectionsTransactionally,
  parseConnectionImport,
  type ConnectionImportPreview,
} from '@/lib/connections/connection-import';
import {
  invokeExportLogFile,
  invokePickLocalFiles,
  invokeReadTextFile,
} from '@/lib/ipc/tauri';
import { useKeychainStore } from '@/stores/keychainStore';
import { createLogger } from '@/lib/logger';
import { useRemoteHealthStore } from '@/stores/remoteHealthStore';

const logger = createLogger('connection-import');

interface WorkbenchProps {
  onCheckForUpdates?: () => void;
  onOpenAbout?: () => void;
  onRequestExit?: () => void;
}

const Workbench: React.FC<WorkbenchProps> = ({
  onCheckForUpdates = () => undefined,
  onOpenAbout = () => undefined,
  onRequestExit = () => undefined,
}) => {
  const { t } = useI18n();
  const { error: showError, success: showSuccess } = useToast();
  const activeTab = useAppStore((state) => state.activeWorkbenchTab);
  const setActiveTab = useAppStore((state) => state.setActiveWorkbenchTab);
  const openSettings = useAppStore((state) => state.openSettings);
  const pendingWorkbenchAction = useAppStore((state) => state.pendingWorkbenchAction);
  const consumeWorkbenchAction = useAppStore((state) => state.consumeWorkbenchAction);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionProfile | undefined>();
  const [deleting, setDeleting] = useState<ConnectionProfile | undefined>();
  const editRequestRef = useRef(0);
  const [initialValues, setInitialValues] = useState<
    { host: string; port: string } | undefined
  >();
  const [importCandidates, setImportCandidates] = useState<ConnectionImportPreview[]>([]);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const { connect } = useConnectSession();
  const {
    open: openSftpConnection,
    hostKeyDialog: sftpHostKeyDialog,
    closeHostKeyDialog: closeSftpHostKeyDialog,
  } = useSftpConnectionOpener();

  const profiles = useProfileStore((state) => state.profiles);
  const profilesInitialized = useProfileStore((state) => state.initialized);
  const addProfile = useProfileStore((state) => state.addProfile);
  const updateProfile = useProfileStore((state) => state.updateProfile);
  const removeProfile = useProfileStore((state) => state.removeProfile);
  const duplicateProfile = useProfileStore((state) => state.duplicateProfile);

  const handleCreateFromKnownHost = (host: string, port: number): void => {
    editRequestRef.current += 1;
    setEditing(undefined);
    setInitialValues({ host, port: String(port) });
    setActiveTab('connections');
    setFormOpen(true);
  };

  const handleAdd = useCallback((): void => {
    editRequestRef.current += 1;
    setEditing(undefined);
    setInitialValues(undefined);
    setFormOpen(true);
  }, []);

  useEffect(() => {
    if (pendingWorkbenchAction !== 'newConnection') return;
    setActiveTab('connections');
    handleAdd();
    consumeWorkbenchAction('newConnection');
  }, [consumeWorkbenchAction, handleAdd, pendingWorkbenchAction, setActiveTab]);

  const handleEdit = useCallback((profile: ConnectionProfile): void => {
    const request = editRequestRef.current + 1;
    editRequestRef.current = request;
    setInitialValues(undefined);

    void useProfileStore.getState().ensurePassword(profile).then((profileWithSecrets) => {
      if (editRequestRef.current !== request) return;
      setEditing(profileWithSecrets);
      setFormOpen(true);
    });
  }, []);

  const handleSubmit = async (
    values: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<void> => {
    if (editing) {
      await updateProfile(editing.id, values);
    } else {
      await addProfile(values);
    }
  };

  const handleSubmitAndConnect = async (
    values: Omit<ConnectionProfile, 'id' | 'createdAt' | 'updatedAt'>,
    connectionAttemptId?: string,
  ): Promise<void> => {
    let profile: ConnectionProfile;
    if (editing) {
      await updateProfile(editing.id, values);
      profile = { ...editing, ...values, updatedAt: Date.now() };
    } else {
      profile = await addProfile(values);
    }
    await connect(profile, { connectionAttemptId });
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleting) return;
    try {
      await removeProfile(deleting.id);
      setDeleting(undefined);
    } catch {
      showError(t('workbench.connections.deleteFailed'));
    }
  };

  const handleDuplicate = useCallback(async (profile: ConnectionProfile): Promise<void> => {
    await duplicateProfile(profile.id);
  }, [duplicateProfile]);

  const handleToggleFavorite = useCallback(async (profile: ConnectionProfile): Promise<void> => {
    try {
      await updateProfile(profile.id, { favorite: !profile.favorite });
    } catch (error) {
      logger.error(`failed to update favorite state for profile ${profile.id}`, error);
      showError(t('workbench.connections.favoriteFailed'));
    }
  }, [showError, t, updateProfile]);

  const connectSftp = useCallback(async (profile: ConnectionProfile): Promise<void> => {
    await openSftpConnection(profile);
  }, [openSftpConnection]);

  const openRemoteHealth = useCallback((profile: ConnectionProfile): void => {
    useRemoteHealthStore.getState().selectProfile(profile.id);
    setActiveTab('monitor');
  }, [setActiveTab]);

  useEffect(() => {
    const handleConnectProfile = (event: Event): void => {
      const detail = (event as CustomEvent<{
        profileId?: string;
        target?: 'terminal' | 'sftp';
        initialDirectory?: string;
        sftpSide?: 'local' | 'remote';
      }>).detail;
      const profile = detail?.profileId
        ? useProfileStore.getState().getProfile(detail.profileId)
        : undefined;
      if (!profile) return;
      if (detail.target === 'sftp') {
        void openSftpConnection(
          profile,
          undefined,
          detail.sftpSide ?? 'remote',
          detail.initialDirectory,
        );
      } else {
        void connect(profile, { initialDirectory: detail.initialDirectory });
      }
    };
    document.addEventListener('shellspan:connect-profile', handleConnectProfile);
    return () => document.removeEventListener('shellspan:connect-profile', handleConnectProfile);
  }, [connect, openSftpConnection]);

  const handleOpenImport = useCallback(async (): Promise<void> => {
    try {
      const [path] = await invokePickLocalFiles();
      if (!path) return;
      const candidates = parseConnectionImport(await invokeReadTextFile(path));
      if (candidates.length === 0) {
        showError(t('workbench.connections.importEmpty'));
        return;
      }
      setImportCandidates(buildConnectionImportPreview(candidates, useProfileStore.getState().profiles));
      setImportDialogOpen(true);
    } catch (error) {
      logger.error('failed to preview connection import', error);
      showError(t('workbench.connections.importFailed'));
    }
  }, [showError, t]);

  const handleExport = useCallback(async (): Promise<void> => {
    try {
      const content = exportConnections(useProfileStore.getState().profiles);
      const path = await invokeExportLogFile('shellspan-connections.json', content);
      if (path) showSuccess(t('workbench.connections.exported', { path }));
    } catch (error) {
      logger.error('failed to export connections', error);
      showError(t('workbench.connections.exportFailed'));
    }
  }, [showError, showSuccess, t]);

  const handleImportSelected = useCallback(async (ids: string[]): Promise<void> => {
    const selected = importCandidates.filter((candidate) => ids.includes(candidate.id));
    setImporting(true);
    try {
      const result = await importConnectionsTransactionally(selected, {
        readTextFile: invokeReadTextFile,
        addKey: (key) => useKeychainStore.getState().addKey(key),
        removeKey: (id) => useKeychainStore.getState().removeKey(id),
        addProfile: (profile) => useProfileStore.getState().addProfile(profile),
        removeProfile: (id) => useProfileStore.getState().removeProfile(id),
        onRollbackError: (resource, id, error) => {
          logger.error(`failed to roll back imported ${resource} ${id}`, error);
        },
      });
      setImportDialogOpen(false);
      showSuccess(t('workbench.connections.imported', { count: result.profileIds.length }));
    } catch (error) {
      logger.error('connection import failed; rolling back batch', error);
      showError(t('workbench.connections.importRolledBack'));
    } finally {
      setImporting(false);
    }
  }, [importCandidates, showError, showSuccess, t]);

  return (
    <div className="flex h-full w-full">
      <WorkbenchSidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onOpenSettings={openSettings}
        onCheckForUpdates={onCheckForUpdates}
        onOpenAbout={onOpenAbout}
        onRequestExit={onRequestExit}
      />

      <div className="flex h-full flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1">
          {activeTab === 'connections' && (
            <ConnectionList
              profiles={profiles}
              initialized={profilesInitialized}
              onAdd={handleAdd}
              onEdit={handleEdit}
              onDelete={setDeleting}
              onConnectTerminal={connect}
              onConnectSftp={connectSftp}
              onOpenHealth={openRemoteHealth}
              onDuplicate={handleDuplicate}
              onToggleFavorite={(profile) => void handleToggleFavorite(profile)}
              onImport={() => void handleOpenImport()}
              onExport={() => void handleExport()}
            />
          )}
          {activeTab === 'knownHosts' && (
            <KnownHostsPanel onCreateConnection={handleCreateFromKnownHost} />
          )}
          {activeTab === 'keychain' && <KeychainPanel />}
          {activeTab === 'monitor' && <MonitorPanel />}
          {activeTab === 'logs' && <LogPanel />}
        </div>
      </div>

      <ConnectionFormDrawer
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSubmit={handleSubmit}
        onConnect={handleSubmitAndConnect}
        initial={editing}
        initialValues={initialValues}
      />

      <ConfirmDeleteDialog
        open={!!deleting}
        onOpenChange={(open) => { if (!open) setDeleting(undefined); }}
        title={t('workbench.connections.deleteTitle')}
        description={deleting ? t('workbench.connections.deleteConfirm', { name: deleting.name }) : ''}
        onConfirm={handleDelete}
      />

      <HostKeyDialog
        open={sftpHostKeyDialog.open}
        onClose={closeSftpHostKeyDialog}
        host={sftpHostKeyDialog.host}
        port={sftpHostKeyDialog.port}
        fingerprint={sftpHostKeyDialog.fingerprint}
        mismatch={sftpHostKeyDialog.mismatch}
        onTrust={sftpHostKeyDialog.onTrust}
      />

      <ConnectionImportDialog
        open={importDialogOpen}
        candidates={importCandidates}
        importing={importing}
        onClose={() => setImportDialogOpen(false)}
        onImport={handleImportSelected}
      />
    </div>
  );
};

export default Workbench;
