import React, { useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { useProfileStore } from '@/stores/profileStore';
import { useAppStore } from '@/stores/appStore';
import { ConnectionForm } from './ConnectionForm';
import { ConnectionList } from './ConnectionList';
import { KnownHostsPanel } from './KnownHostsPanel';
import { LogPanel } from './LogPanel';
import { WorkbenchSidebar, type WorkbenchTab } from './WorkbenchSidebar';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import type { ConnectionProfile } from '@/types';
import {
  buildRemoteConnectionRequest,
  buildSessionCreateRequest,
  invokeCreateSession,
  invokeTrustHost,
} from '@/lib/tauri';
import { useTerminalStore } from '@/stores/terminalStore';
import { useSftpStore } from '@/stores/sftpStore';
import { PortForwardDialog } from './PortForwardDialog';
import {
  buildConnectionKey,
  startPortForwardsForProfile,
  stopPortForwardsForProfile,
  usePortForwardStore,
} from '@/stores/portForwardStore';


const Workbench: React.FC = () => {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('connections');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionProfile | undefined>();
  const [deleting, setDeleting] = useState<ConnectionProfile | undefined>();
  const [hostKeyDialog, setHostKeyDialog] = useState<{
    open: boolean;
    host: string;
    port: number;
    fingerprint?: string;
    mismatch: boolean;
    onTrust: () => void;
  }>({
    open: false,
    host: '',
    port: 22,
    mismatch: false,
    onTrust: () => {},
  });
  const [portForwardProfile, setPortForwardProfile] = useState<
    ConnectionProfile | undefined
  >();

  const profiles = useProfileStore((state) => state.profiles);
  const addProfile = useProfileStore((state) => state.addProfile);
  const updateProfile = useProfileStore((state) => state.updateProfile);
  const removeProfile = useProfileStore((state) => state.removeProfile);
  const duplicateProfile = useProfileStore((state) => state.duplicateProfile);
  const ensurePassword = useProfileStore((state) => state.ensurePassword);

  const setActiveSection = useAppStore((state) => state.setActiveSection);
  const addTerminalSession = useTerminalStore((state) => state.addSession);
  const addSftpConnection = useSftpStore((state) => state.addConnection);

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

  const handlePortForward = (profile: ConnectionProfile): void => {
    setPortForwardProfile(profile);
  };

  const handleStartPortForwards = async (
    forwards: import('@/types').PortForwardConfig[],
  ): Promise<void> => {
    if (!portForwardProfile) return;
    const profile = await ensurePassword(portForwardProfile);
    await startPortForwardsForProfile(profile, forwards);
    setPortForwardProfile(undefined);
  };

  const handleStopPortForwards = async (): Promise<void> => {
    if (!portForwardProfile) return;
    const key = buildConnectionKey(
      portForwardProfile.host,
      portForwardProfile.port,
      portForwardProfile.username,
    );
    await stopPortForwardsForProfile(key);
    setPortForwardProfile(undefined);
  };

  const connectTerminal = async (
    profile: ConnectionProfile,
  ): Promise<void> => {
    const profileWithPassword = await ensurePassword(profile);
    try {
      const summary = await invokeCreateSession(
        buildSessionCreateRequest(profileWithPassword, 120, 30),
      );
      addTerminalSession(summary);
      setActiveSection('terminal');
    } catch (error) {
      handleConnectionError(error, () => connectTerminal(profileWithPassword));
    }
  };

  const connectSftp = async (profile: ConnectionProfile): Promise<void> => {
    const profileWithPassword = await ensurePassword(profile);
    const connection = buildRemoteConnectionRequest(profileWithPassword);
    const summary = {
      sessionId: profile.id,
      title: profile.name,
      host: profile.host,
      port: profile.port,
      username: profile.username,
    };
    addSftpConnection(summary, connection);
    setActiveSection('sftp');
  };

  const handleConnectionError = (
    error: unknown,
    retry: () => void,
  ): void => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'type' in error
    ) {
      const typed = error as { type: string; payload?: Record<string, unknown> };
      if (typed.type === 'HostKeyUnknown') {
        const payload = typed.payload ?? {};
        setHostKeyDialog({
          open: true,
          host: String(payload.host ?? ''),
          port: Number(payload.port ?? 22),
          fingerprint: payload.fingerprint
            ? String(payload.fingerprint)
            : undefined,
          mismatch: false,
          onTrust: () => {
            invokeTrustHost(String(payload.host ?? ''), Number(payload.port ?? 22)).then(() => {
              setHostKeyDialog((prev) => ({ ...prev, open: false }));
              retry();
            });
          },
        });
        return;
      }
      if (typed.type === 'HostKeyMismatch') {
        const payload = typed.payload ?? {};
        setHostKeyDialog({
          open: true,
          host: String(payload.host ?? ''),
          port: Number(payload.port ?? 22),
          mismatch: true,
          onTrust: () => {
            invokeTrustHost(String(payload.host ?? ''), Number(payload.port ?? 22)).then(() => {
              setHostKeyDialog((prev) => ({ ...prev, open: false }));
              retry();
            });
          },
        });
        return;
      }
    }
    // eslint-disable-next-line no-alert
    alert(error instanceof Error ? error.message : String(error));
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
              onConnectTerminal={connectTerminal}
              onConnectSftp={connectSftp}
              onDuplicate={handleDuplicate}
              onPortForward={handlePortForward}
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

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(undefined)}
        onConfirm={handleDelete}
        title={t('common.delete')}
        message={deleting ? `${deleting.name}` : ''}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
      />

      <HostKeyDialog
        open={hostKeyDialog.open}
        onClose={() => setHostKeyDialog((prev) => ({ ...prev, open: false }))}
        host={hostKeyDialog.host}
        port={hostKeyDialog.port}
        fingerprint={hostKeyDialog.fingerprint}
        mismatch={hostKeyDialog.mismatch}
        onTrust={hostKeyDialog.onTrust}
      />

      <PortForwardDialog
        open={!!portForwardProfile}
        onClose={() => setPortForwardProfile(undefined)}
        onStart={handleStartPortForwards}
        onStop={handleStopPortForwards}
        activeForwards={
          portForwardProfile
            ? usePortForwardStore
                .getState()
                .findByConnection(
                  buildConnectionKey(
                    portForwardProfile.host,
                    portForwardProfile.port,
                    portForwardProfile.username,
                  ),
                )?.forwards
            : undefined
        }
      />
    </div>
  );
};

interface HostKeyDialogProps {
  open: boolean;
  onClose: () => void;
  host: string;
  port: number;
  fingerprint?: string;
  mismatch: boolean;
  onTrust: () => void;
}

const HostKeyDialog: React.FC<HostKeyDialogProps> = ({
  open,
  onClose,
  host,
  port,
  fingerprint,
  mismatch,
  onTrust,
}) => {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        mismatch
          ? t('dialog.hostKeyMismatch.title')
          : t('dialog.hostKeyUnknown.title')
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={onTrust}>
            {t('dialog.hostKey.trustAndConnect')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="text-sm text-app-text">
          {mismatch
            ? t('dialog.hostKeyMismatch.message', { host, port })
            : t('dialog.hostKeyUnknown.message', { host, port })}
        </p>
        {fingerprint && (
          <div className="rounded-[4px] bg-app-surface-muted p-2 font-mono text-xs text-app-text">
            {fingerprint}
          </div>
        )}
      </div>
    </Dialog>
  );
};

export default Workbench;
