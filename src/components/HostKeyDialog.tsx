import { Dialog, DialogFooter, DialogHeader, DialogPanel } from './ui';
import { t } from '../lib/i18n';
import type { ConnectionProfile } from '../types';

interface HostKeyDialogProps {
  open: boolean;
  profile?: ConnectionProfile;
  fingerprint?: string;
  onClose: () => void;
  onTrustAndConnect: () => void;
}

export function HostKeyDialog({ open, profile, fingerprint, onClose, onTrustAndConnect }: HostKeyDialogProps) {
  return (
    <Dialog open={open} onClose={onClose}>
      <DialogPanel className="app-dialog surface w-full max-w-md p-4" ariaLabel={t('hostKey.dialog.ariaLabel')}>
        <DialogHeader
          kicker={t('hostKey.dialog.kicker')}
          title={t('hostKey.dialog.title', { host: profile?.host ?? '' })}
        />
        <p className="dialog-description mt-3 text-xs">{t('hostKey.dialog.description')}</p>
        <div className="mt-3 bg-slate-900/80 p-3 font-mono text-xs text-slate-300 break-all">{fingerprint}</div>
        <p className="mt-3 text-[11px] text-amber-400/80">{t('hostKey.dialog.warning')}</p>
        <DialogFooter className="mt-4 flex justify-end gap-2">
          <button className="btn-cancel" onClick={onClose} type="button">
            {t('app.common.cancel')}
          </button>
          <button className="btn-primary" onClick={onTrustAndConnect} type="button">
            {t('hostKey.dialog.trustAndConnect')}
          </button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>
  );
}
