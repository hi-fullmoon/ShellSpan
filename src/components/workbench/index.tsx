import React, { useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useProfileStore } from '@/stores/profileStore';
import { useAppStore } from '@/stores/appStore';
import { ConnectionForm } from './connection-form';
import { ConnectionList } from './connection-list';
import { KnownHostsPanel } from './known-hosts-panel';
import { CredentialsPanel } from './credentials-panel';
import { LogPanel } from './log-panel';
import { SettingsPanel } from './settings-panel';
import { WorkbenchSidebar } from './workbench-sidebar';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '@/components/ui/alert-dialog';
import { HostKeyDialog } from '@/components/terminal/host-key-dialog';
import type { ConnectionProfile } from '@/types';
import { useConnectSession } from '@/hooks/useConnectSession';
import { useSftpConnectionOpener } from '@/hooks/useSftpConnectionOpener';

const Workbench: React.FC = () => {
  const { t } = useI18n();
  const activeTab = useAppStore((state) => state.activeWorkbenchTab);
  const setActiveTab = useAppStore((state) => state.setActiveWorkbenchTab);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionProfile | undefined>();
  const [deleting, setDeleting] = useState<ConnectionProfile | undefined>();
  const [initialValues, setInitialValues] = useState<
    { host: string; port: string } | undefined
  >();
  const { connect, hostKeyDialog, closeHostKeyDialog } = useConnectSession();
  const {
    open: openSftpConnection,
    hostKeyDialog: sftpHostKeyDialog,
    closeHostKeyDialog: closeSftpHostKeyDialog,
  } = useSftpConnectionOpener();

  const profiles = useProfileStore((state) => state.profiles);
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

  const handleAdd = (): void => {
    setEditing(undefined);
    setInitialValues(undefined);
    setFormOpen(true);
  };

  const handleEdit = (profile: ConnectionProfile): void => {
    setEditing(profile);
    setInitialValues(undefined);
    setFormOpen(true);
  };

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
    await connect(profile);
  };

  const handleDelete = async (): Promise<void> => {
    if (!deleting) return;
    await removeProfile(deleting.id);
    setDeleting(undefined);
  };

  const handleDuplicate = async (profile: ConnectionProfile): Promise<void> => {
    await duplicateProfile(profile.id);
  };

  const connectSftp = async (profile: ConnectionProfile): Promise<void> => {
    await openSftpConnection(profile);
  };

  return (
    <div className="flex h-full w-full">
      <WorkbenchSidebar activeTab={activeTab} onTabChange={setActiveTab} />

      <div className="flex h-full flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1">
          {activeTab === 'connections' && (
            <ConnectionList
              profiles={profiles}
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
          {activeTab === 'credentials' && (
            <CredentialsPanel />
          )}
          {activeTab === 'logs' && <LogPanel />}
          {activeTab === 'settings' && <SettingsPanel />}
        </div>
      </div>

      <ConnectionForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSubmit={handleSubmit}
        onConnect={handleSubmitAndConnect}
        initial={editing}
        initialValues={initialValues}
      />

      <AlertDialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(undefined); }}>
        <AlertDialogContent className="min-w-0 max-w-sm gap-0 overflow-hidden border-app-border bg-app-surface p-0">
          <AlertDialogHeader className="place-items-start px-4 py-2.5 text-left">
            <AlertDialogTitle className="text-sm leading-5">{t('common.delete')}</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="min-w-0 max-w-full overflow-hidden px-4 py-3">
            <AlertDialogDescription className="block min-w-0 max-w-full break-all text-left leading-5 text-app-text">
              {deleting ? deleting.name : ''}
            </AlertDialogDescription>
          </div>
          <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-app-surface px-4 py-2.5">
            <AlertDialogCancel size="sm" onClick={() => setDeleting(undefined)}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" size="sm" onClick={handleDelete}>
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <HostKeyDialog
        open={hostKeyDialog.open}
        onClose={closeHostKeyDialog}
        host={hostKeyDialog.host}
        port={hostKeyDialog.port}
        fingerprint={hostKeyDialog.fingerprint}
        mismatch={hostKeyDialog.mismatch}
        onTrust={hostKeyDialog.onTrust}
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
