import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/hooks/useI18n';

interface UpdateRestartDialogProps {
  open: boolean;
  version: string;
  hasActiveSessions: boolean;
  downloadProgress?: number;
  onInstallNow: () => void;
  onLater: () => void;
}

export const UpdateRestartDialog: React.FC<UpdateRestartDialogProps> = ({
  open,
  version,
  hasActiveSessions,
  downloadProgress,
  onInstallNow,
  onLater,
}) => {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onLater(); }}>
      <DialogContent className="max-w-md bg-app-surface border-app-border">
        <DialogHeader>
          <DialogTitle>{t('update.restartDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('update.restartDialog.description', { version })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          {typeof downloadProgress === 'number' ? (
            <p className="text-sm text-app-text-soft">
              {t('update.progress', { progress: Math.max(0, Math.min(100, downloadProgress)) })}
            </p>
          ) : null}

          {hasActiveSessions ? (
            <div className="rounded-md border border-app-warning/20 bg-app-warning/10 px-3 py-2 text-sm text-app-warning">
              {t('update.restartDialog.activeSessionWarning')}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onLater}>
            {t('update.restartDialog.later')}
          </Button>
          <Button onClick={onInstallNow}>
            {t('update.restartDialog.installNow')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
