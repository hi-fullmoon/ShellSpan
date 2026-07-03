import { ConnectionForm } from './ConnectionForm';
import { Dialog, DialogHeader, DialogPanel } from './ui';
import { t } from '../lib/i18n';
import type { ConnectionProfile } from '../types';

interface ConnectDialogProps {
  open: boolean;
  draftProfile: ConnectionProfile;
  isConnecting?: boolean;
  onClose: () => void;
  onProfileChange: (profile: ConnectionProfile) => void;
  onConnect: (profile: ConnectionProfile, remember: boolean, rememberPassword: boolean) => void;
}

export function ConnectDialog({ open, draftProfile, isConnecting, onClose, onProfileChange, onConnect }: ConnectDialogProps) {
  return (
    <Dialog open={open} onClose={onClose}>
      <DialogPanel className="flex max-h-[calc(100vh-28px)] w-[516px] flex-col overflow-hidden p-0!">
        <DialogHeader
          className="shrink-0 px-4 pt-4 pb-2"
          closeLabel={t('app.connectDialog.close')}
          kicker={t('app.connectDialog.kicker')}
          onClose={onClose}
          title={t('app.connectDialog.title')}
        />
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-3">
          <ConnectionForm profile={draftProfile} isConnecting={isConnecting} onProfileChange={onProfileChange} onConnect={onConnect} />
        </div>
      </DialogPanel>
    </Dialog>
  );
}
