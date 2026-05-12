import { ConnectionForm } from './ConnectionForm';
import { Dialog, DialogHeader } from './Dialog';
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
      <ScrollArea
        className="app-dialog surface max-h-[calc(100vh-16px)] w-full max-w-xl p-2.5 rounded-lg!"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('app.connectDialog.ariaLabel')}
        orientation="both"
      >
        <DialogHeader
          className="mb-2"
          closeLabel={t('app.connectDialog.close')}
          kicker={t('app.connectDialog.kicker')}
          onClose={onClose}
          title={t('app.connectDialog.title')}
        />
        <ConnectionForm
          profile={draftProfile}
          isConnecting={isConnecting}
          onProfileChange={onProfileChange}
          onConnect={onConnect}
        />
      </ScrollArea>
    </Dialog>
  );
}
