import React from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  CompactDialogBody,
  CompactDialogContent,
  CompactDialogFooter,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';
import { useI18n } from '@/hooks/useI18n';

interface UpdateRestartDialogProps {
  open: boolean;
  version: string;
  hasActiveSessions: boolean;
  activeTransferCount: number;
  downloadProgress?: number;
  onInstallNow: () => void;
  onLater: () => void;
}

export const UpdateRestartDialog: React.FC<UpdateRestartDialogProps> = ({
  open,
  version,
  hasActiveSessions,
  activeTransferCount,
  downloadProgress,
  onInstallNow,
  onLater,
}) => {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onLater(); }}>
      <CompactDialogContent className="max-w-sm" showCloseButton={false}>
        <CompactDialogHeader
          title={t('update.restartDialog.title')}
          description={t('update.restartDialog.description', { version })}
        />
        <CompactDialogBody>
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
          {activeTransferCount > 0 ? (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {t('update.restartDialog.activeTransferWarning', { count: activeTransferCount })}
            </div>
          ) : null}
        </CompactDialogBody>
        <CompactDialogFooter>
          <Button variant="outline" size="sm" onClick={onLater}>
            {t('update.restartDialog.later')}
          </Button>
          <Button size="sm" onClick={onInstallNow}>
            {t('update.restartDialog.installNow')}
          </Button>
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  );
};
