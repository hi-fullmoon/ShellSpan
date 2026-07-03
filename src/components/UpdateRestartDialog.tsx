import { Dialog, DialogFooter, DialogHeader, DialogPanel } from './ui';
import { t } from '../lib/i18n';

interface UpdateRestartDialogProps {
  open: boolean;
  version: string;
  hasActiveSessions: boolean;
  downloadProgress?: number;
  onInstallNow: () => void;
  onLater: () => void;
}

export function UpdateRestartDialog({ open, version, hasActiveSessions, downloadProgress, onInstallNow, onLater }: UpdateRestartDialogProps) {
  return (
    <Dialog open={open} onClose={onLater}>
      <DialogPanel className="surface rounded-lg w-full max-w-md p-3" ariaLabel={t('updateRestartDialog.ariaLabel')}>
        <DialogHeader
          description={t('updateRestartDialog.description', { version })}
          kicker={t('updateRestartDialog.kicker')}
          title={t('updateRestartDialog.title')}
        />
        {typeof downloadProgress === 'number' ? (
          <p className="text-xs text-cyan-300">{t('updateRestartDialog.progress', { progress: Math.max(0, Math.min(100, downloadProgress)) })}</p>
        ) : null}

        {hasActiveSessions ? (
          <div className="mt-2 border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">{t('updateRestartDialog.warning')}</div>
        ) : null}

        <DialogFooter>
          <button className="btn-cancel" onClick={onLater} type="button">
            {t('updateRestartDialog.later')}
          </button>
          <button className="btn-primary" onClick={onInstallNow} type="button">
            {t('updateRestartDialog.installNow')}
          </button>
        </DialogFooter>
      </DialogPanel>
    </Dialog>
  );
}
