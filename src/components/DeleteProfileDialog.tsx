import { Dialog, DialogFooter, DialogHeader, DialogPanel } from './Dialog';
import { t } from '../lib/i18n';
import type { ConnectionProfile } from '../types';

interface DeleteProfileDialogProps {
  open: boolean;
  profile?: ConnectionProfile;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteProfileDialog({ open, profile, onClose, onConfirm }: DeleteProfileDialogProps) {
  return (
    <Dialog open={open} onClose={onClose}>
      <DialogPanel className="w-full max-w-sm p-3" ariaLabel={t('app.deleteProfileDialog.ariaLabel')}>
        <DialogHeader
          description={t('app.deleteProfileDialog.description', { name: profile?.name ?? '' })}
          kicker={t('app.deleteProfileDialog.kicker')}
          title={t('app.deleteProfileDialog.title')}
        />
        <DialogFooter>
          <button className="btn-cancel" onClick={onClose} type="button">
            {t('app.common.cancel')}
          </button>
          <button className="btn-danger" onClick={onConfirm} type="button">
            {t('app.common.delete')}
          </button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>
  );
}
