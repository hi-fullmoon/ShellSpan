import { Dialog, DialogHeader, DialogPanel } from './Dialog';
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
  return (
    <Dialog open={open} onClose={onClose}>
      <DialogPanel className="settings-dialog">
        <DialogHeader
          className="settings-dialog-header"
          closeLabel={t('settings.close')}
          description={t('settings.description')}
          kicker={t('settings.subtitle')}
          onClose={onClose}
          title={t('settings.title')}
        />
        <SettingsPanel onChange={onChange} preferences={preferences} />
      </DialogPanel>
    </Dialog>
  );
}
