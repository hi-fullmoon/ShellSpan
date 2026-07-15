import React, { useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { useProfileStore } from '@/stores/profileStore';
import { ConnectionForm } from './connection-form';
import { ConnectionList } from './connection-list';
import { KnownHostsPanel } from './known-hosts-panel';
import { LogPanel } from './log-panel';
import { WorkbenchSidebar, type WorkbenchTab } from './workbench-sidebar';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel } from '@/components/ui/alert-dialog';
import { HostKeyDialog } from '@/components/terminal/host-key-dialog';
import type { ConnectionProfile } from '@/types';
import { useConnectSession } from '@/hooks/useConnectSession';
import { useSftpConnectionOpener } from '@/hooks/useSftpConnectionOpener';

const Workbench: React.FC = () => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('connections');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionProfile | undefined>();
  const [deleting, setDeleting] = useState<ConnectionProfile | undefined>();
  const { connect, hostKeyDialog, closeHostKeyDialog } = useConnectSession();
  const { open: openSftpConnection } = useSftpConnectionOpener();

  const profiles = useProfileStore((state) => state.profiles);
  const addProfile = useProfileStore((state) => state.addProfile);
  const updateProfile = useProfileStore((state) => state.updateProfile);
  const removeProfile = useProfileStore((state) => state.removeProfile);
  const duplicateProfile = useProfileStore((state) => state.duplicateProfile);

  const handleAdd = (): void => {
    setEditing(undefined);
    setFormOpen(true);
  };

  const handleEdit = (profile: ConnectionProfile): void => {
    setEditing(profile);
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
          {activeTab === 'knownHosts' && <KnownHostsPanel />}
          {activeTab === 'logs' && <LogPanel />}
        </div>
      </div>

      <ConnectionForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSubmit={handleSubmit}
        initial={editing}
      />

      <AlertDialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(undefined); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('common.delete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting ? deleting.name : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleting(undefined)}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
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
    </div>
  );
};

export default Workbench;
