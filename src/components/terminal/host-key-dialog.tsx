import React from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react';

// ShieldIcon replaced with lucide-react imports

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
      <DialogContent className="bg-app-surface border-app-border">
        <DialogHeader>
          <DialogTitle>
            <div className="flex items-center gap-2">
              {mismatch ? <ShieldAlertIcon className="h-5 w-5 text-app-error" /> : <ShieldCheckIcon className="h-5 w-5 text-app-primary" />}
              <span>{title}</span>
            </div>
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
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
              <div className="rounded-lg border border-app-border bg-app-surface-muted/50 p-3">
                <code className="break-all font-mono text-[11px] leading-relaxed text-app-text">
                  {fingerprint}
                </code>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="default" onClick={onTrust}>
            {t('dialog.hostKey.trustAndConnect')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
