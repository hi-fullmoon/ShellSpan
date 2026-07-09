import React from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

export interface HostKeyDialogProps {
  open: boolean;
  onClose: () => void;
  host: string;
  port: number;
  fingerprint?: string;
  mismatch: boolean;
  onTrust: () => void;
}

export const HostKeyDialog: React.FC<HostKeyDialogProps> = ({
  open,
  onClose,
  host,
  port,
  fingerprint,
  mismatch,
  onTrust,
}) => {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        mismatch
          ? t('dialog.hostKeyMismatch.title')
          : t('dialog.hostKeyUnknown.title')
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={onTrust}>
            {t('dialog.hostKey.trustAndConnect')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="text-sm text-app-text">
          {mismatch
            ? t('dialog.hostKeyMismatch.message', { host, port })
            : t('dialog.hostKeyUnknown.message', { host, port })}
        </p>
        {fingerprint && (
          <div className="rounded-[4px] bg-app-surface-muted p-2 font-mono text-xs text-app-text">
            {fingerprint}
          </div>
        )}
      </div>
    </Dialog>
  );
};
