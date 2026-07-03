import { Dialog, DialogFooter, DialogHeader, DialogPanel } from './ui';
import { t } from '../lib/i18n';

interface ExitAppDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function ExitAppDialog({ open, onClose, onConfirm }: ExitAppDialogProps) {
  return (
    <Dialog open={open} onClose={onClose}>
      <DialogPanel className="w-full max-w-sm p-3" ariaLabel={t('app.exitDialog.ariaLabel')}>
        <DialogHeader
          description={t('app.exitDialog.description')}
          kicker={t('app.exitDialog.kicker')}
          title={t('app.exitDialog.title')}
        />
        <DialogFooter>
          <button className="btn-cancel" onClick={onClose} type="button">
            {t('app.common.cancel')}
          </button>
          <button className="btn-danger" onClick={onConfirm} type="button">
            {t('app.common.exit')}
          </button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>
  );
}
