import React from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const ShieldIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    {className?.includes('text-app-error') ? (
      <>
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </>
    ) : (
      <path d="M9 12l2 2 4-4" />
    )}
  </svg>
);

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
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <ShieldIcon
            className={cn(
              'h-5 w-5',
              mismatch ? 'text-app-error' : 'text-app-primary',
            )}
          />
          <span>{title}</span>
        </div>
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
      <div className="flex flex-col gap-3">
        <p className="text-sm text-app-text">
          {mismatch
            ? t('dialog.hostKeyMismatch.message', { host, port })
            : t('dialog.hostKeyUnknown.message', { host, port })}
        </p>
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
    </Dialog>
  );
};
