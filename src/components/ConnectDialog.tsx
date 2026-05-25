import { ConnectionForm } from './ConnectionForm';
import { Dialog, DialogHeader, DialogPanel } from './Dialog';
import { ScrollArea } from './ScrollArea';
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
      <DialogPanel className="max-h-[calc(100vh-28px)] max-w-2xl p-0! flex flex-col">
        <ScrollArea orientation="both" className="flex-1 min-h-0">
          <div className="px-4 pt-4 pb-3">
            <DialogHeader
              className="mb-2"
              closeLabel={t('app.connectDialog.close')}
              kicker={t('app.connectDialog.kicker')}
              onClose={onClose}
              title={t('app.connectDialog.title')}
            />
            <ConnectionForm profile={draftProfile} isConnecting={isConnecting} onProfileChange={onProfileChange} onConnect={onConnect} />
          </div>
        </ScrollArea>
      </DialogPanel>
    </Dialog>
  );
}
