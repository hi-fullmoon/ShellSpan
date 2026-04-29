import { CloseIcon } from './Icons';
import { t } from '../lib/i18n';
import { SettingsPanel } from './SettingsPanel';
import type { AppPreferences } from '../types';

interface SettingsDialogProps {
  open: boolean;
  preferences: AppPreferences;
  onChange: (nextPreferences: AppPreferences) => void;
  onClose: () => void;
}

export function SettingsDialog({
  open,
  preferences,
  onChange,
  onClose,
}: SettingsDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="app-overlay" role="presentation">
      <div
        className="app-dialog settings-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
      >
        <div className="settings-dialog-header">
          <div>
            <p className="label">{t('settings.subtitle')}</p>
            <h3 className="dialog-title">{t('settings.title')}</h3>
            <p className="dialog-description">{t('settings.description')}</p>
          </div>
          <button aria-label={t('settings.close')} className="icon-btn" onClick={onClose} type="button">
            <CloseIcon />
          </button>
        </div>

        <SettingsPanel
          onChange={onChange}
          preferences={preferences}
        />
      </div>
    </div>
  );
}
