import React, { useCallback, useState } from 'react';
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
import { SettingsPanel } from './settings-panel';
import { WorkbenchSidebar } from './workbench-sidebar';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { HostKeyDialog } from '@/components/terminal/host-key-dialog';
import type { ConnectionProfile } from '@/types';
import { useConnectSession } from '@/hooks/useConnectSession';
import { useSftpConnectionOpener } from '@/hooks/useSftpConnectionOpener';

const Workbench: React.FC = () => {
  const { t } = useI18n();
  const { error: showError } = useToast();
  const activeTab = useAppStore((state) => state.activeWorkbenchTab);
  const setActiveTab = useAppStore((state) => state.setActiveWorkbenchTab);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionProfile | undefined>();
  const [deleting, setDeleting] = useState<ConnectionProfile | undefined>();
  const [initialValues, setInitialValues] = useState<
    { host: string; port: string } | undefined
  >();
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
    setEditing(undefined);
    setInitialValues({ host, port: String(port) });
    setActiveTab('connections');
    setFormOpen(true);
  };

  const handleAdd = useCallback((): void => {
    setEditing(undefined);
    setInitialValues(undefined);
    setFormOpen(true);
  }, []);

  const handleEdit = useCallback((profile: ConnectionProfile): void => {
    setEditing(profile);
    setInitialValues(undefined);
    setFormOpen(true);
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
  ): Promise<void> => {
    let profile: ConnectionProfile;
    if (editing) {
      await updateProfile(editing.id, values);
      profile = { ...editing, ...values, updatedAt: Date.now() };
    } else {
      profile = await addProfile(values);
    }
    void connect(profile);
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

  const connectSftp = useCallback(async (profile: ConnectionProfile): Promise<void> => {
    await openSftpConnection(profile);
  }, [openSftpConnection]);

  return (
    <div className="flex h-full w-full">
      <WorkbenchSidebar activeTab={activeTab} onTabChange={setActiveTab} />

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
              onDuplicate={handleDuplicate}
            />
          )}
          {activeTab === 'knownHosts' && (
            <KnownHostsPanel onCreateConnection={handleCreateFromKnownHost} />
          )}
          {activeTab === 'keychain' && <KeychainPanel />}
          {activeTab === 'monitor' && <MonitorPanel />}
          {activeTab === 'logs' && <LogPanel />}
          {activeTab === 'settings' && <SettingsPanel />}
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
    </div>
  );
};

export default Workbench;
