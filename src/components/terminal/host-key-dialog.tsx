import React from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription } from '@/components/ui/dialog';
import {
  CompactDialogBody,
  CompactDialogContent,
  CompactDialogFooter,
  CompactDialogHeader,
} from '@/components/ui/compact-dialog';

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
  const title = mismatch
    ? t('dialog.hostKeyMismatch.title')
    : t('dialog.hostKeyUnknown.title');

  return (
    <Dialog open={open} onOpenChange={(open) => { if (!open) onClose(); }}>
      <CompactDialogContent className="max-w-sm" showCloseButton={false}>
        <CompactDialogHeader title={title} />
        <CompactDialogBody>
          <DialogDescription className="text-app-text">
            {mismatch
              ? t('dialog.hostKeyMismatch.message', { host, port })
              : t('dialog.hostKeyUnknown.message', { host, port })}
          </DialogDescription>
          {fingerprint && (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wider text-app-text-soft">
                {t('dialog.hostKey.fingerprint')}
              </span>
              <div className="rounded-md border border-app-border bg-app-surface-muted/50 p-2.5">
                <code className="break-all font-mono text-[11px] leading-relaxed text-app-text">
                  {fingerprint}
                </code>
              </div>
            </div>
          )}
        </CompactDialogBody>
        <CompactDialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={onTrust}>
            {t('dialog.hostKey.trustAndConnect')}
          </Button>
        </CompactDialogFooter>
      </CompactDialogContent>
    </Dialog>
  );
};
