import { Dialog, DialogHeader, DialogPanel } from './ui';
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
      <DialogPanel className="flex h-[640px] max-h-[84vh] w-full max-w-xl flex-col overflow-hidden">
        <DialogHeader
          className="flex items-start justify-between gap-3 px-4 pt-4 pb-2 shrink-0"
          closeLabel={t('settings.close')}
          description={t('settings.description')}
          kicker={t('settings.subtitle')}
          onClose={onClose}
          title={t('settings.title')}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SettingsPanel onChange={onChange} preferences={preferences} />
        </div>
      </DialogPanel>
    </Dialog>
  );
}
