import { t } from '../lib/i18n';

interface UpdateRestartDialogProps {
  open: boolean;
  version: string;
  hasActiveSessions: boolean;
  downloadProgress?: number;
  onInstallNow: () => void;
  onLater: () => void;
}

export function UpdateRestartDialog({
  open,
  version,
  hasActiveSessions,
  downloadProgress,
  onInstallNow,
  onLater,
}: UpdateRestartDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-40 grid place-items-center bg-slate-950/70 p-1 backdrop-blur md:p-2"
      role="presentation"
    >
      <div
        className="surface rounded-xl w-full max-w-md p-3"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('updateRestartDialog.ariaLabel')}
      >
        <div className="flex flex-col gap-1">
          <p className="label">{t('updateRestartDialog.kicker')}</p>
          <h3 className="text-sm font-semibold text-slate-100">{t('updateRestartDialog.title')}</h3>
          <p className="text-xs text-slate-400">{t('updateRestartDialog.description', { version })}</p>
          {typeof downloadProgress === "number" ? (
            <p className="text-xs text-cyan-300">
              {t('updateRestartDialog.progress', { progress: Math.max(0, Math.min(100, downloadProgress)) })}
            </p>
          ) : null}
        </div>

        {hasActiveSessions ? (
          <div className="mt-2 border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-200">
            {t('updateRestartDialog.warning')}
          </div>
        ) : null}

        <div className="mt-3 flex justify-end gap-1">
          <button className="btn-cancel" onClick={onLater} type="button">
            {t('updateRestartDialog.later')}
          </button>
          <button className="btn-primary" onClick={onInstallNow} type="button">
            {t('updateRestartDialog.installNow')}
          </button>
        </div>
      </div>
    </div>
  );
}
