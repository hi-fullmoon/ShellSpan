import { Dialog, DialogFooter, DialogHeader, DialogPanel } from './Dialog';
import { t } from '../lib/i18n';
import type { SessionState } from '../types';

interface CloseSessionDialogProps {
  open: boolean;
  session?: SessionState;
  onClose: () => void;
  onConfirm: () => void;
}

export function CloseSessionDialog({ open, session, onClose, onConfirm }: CloseSessionDialogProps) {
  return (
    <Dialog open={open} onClose={onClose}>
      <DialogPanel className="w-full max-w-sm p-3" ariaLabel={t('app.closeSessionDialog.ariaLabel')}>
        <DialogHeader
          description={t('app.closeSessionDialog.description', { name: session?.title ?? '' })}
          kicker={t('app.closeSessionDialog.kicker')}
          title={t('app.closeSessionDialog.title')}
        />
        <DialogFooter>
          <button className="btn-cancel" onClick={onClose} type="button">
            {t('app.common.cancel')}
          </button>
          <button className="btn-danger" onClick={onConfirm} type="button">
            {t('app.common.close')}
          </button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>
  );
}
