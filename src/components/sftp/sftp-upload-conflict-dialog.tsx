import React, { useState } from 'react';
import { Dialog, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/hooks/useI18n';
import type { PendingUploadConflict } from '@/hooks/useSftpPaneActions';
import { kindLabel } from '@/lib/sftp-utils';
import { FileWarningIcon } from 'lucide-react';
import {
  SftpDialogBody,
  SftpDialogContent,
  SftpDialogFooter,
  SftpDialogHeader,
} from './sftp-dialog-layout';

export type UploadConflictAction = 'overwrite' | 'replace' | 'skip' | 'cancel';

export interface SftpUploadConflictDialogProps {
  conflict?: PendingUploadConflict;
  open: boolean;
  onClose: () => void;
  onResolve: (action: UploadConflictAction, applyToRemaining: boolean) => void;
}

export const SftpUploadConflictDialog: React.FC<SftpUploadConflictDialogProps> = ({
  conflict,
  open,
  onClose,
  onResolve,
}) => {
  const { t } = useI18n();
  const [applyToRemaining, setApplyToRemaining] = useState(false);

  if (!conflict) return null;

  const handleAction = (action: UploadConflictAction): void => {
    // Do not call onClose here: onResolve may synchronously queue the next
    // conflict, and onClose dismisses the whole batch. The parent closes the
    // dialog by clearing the conflict state once the resolution is handled.
    onResolve(action, applyToRemaining);
    setApplyToRemaining(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SftpDialogContent className="max-w-sm" showCloseButton={false}>
        <SftpDialogHeader title={t('sftp.conflict.title')} />
        <SftpDialogBody>
          <DialogDescription className="min-w-0 break-words text-app-text">
            {t('sftp.conflict.message', { name: conflict.targetName })}
          </DialogDescription>
          <div className="flex min-w-0 items-center gap-3 overflow-hidden rounded-lg border border-app-border bg-app-surface-muted/45 p-3">
            <FileWarningIcon className="size-5 shrink-0 text-app-text-soft" aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="block w-full truncate text-sm font-medium text-app-text" title={conflict.targetName}>
                {conflict.targetName}
              </span>
              <span className="text-xs text-app-text-soft">
                {kindLabel(conflict.existingKind, t)}
              </span>
            </div>
          </div>
          {conflict.remainingConflicts > 0 && (
            <div className="flex items-center gap-2 rounded-md px-1 py-1">
              <Checkbox
                id="apply-to-remaining"
                checked={applyToRemaining}
                onCheckedChange={(checked) => setApplyToRemaining(checked === true)}
              />
              <Label htmlFor="apply-to-remaining" className="text-xs text-app-text">
                {t('sftp.conflict.applyToRemaining')}
              </Label>
            </div>
          )}
        </SftpDialogBody>
        <SftpDialogFooter>
          <Button variant="outline" size="sm" onClick={() => handleAction('cancel')}>
            {t('sftp.conflict.cancel')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => handleAction('skip')}>
            {t('sftp.conflict.skip')}
          </Button>
          <Button
            variant={
              conflict.existingKind === 'directory'
                ? 'secondary'
                : 'destructive'
            }
            size="sm"
            onClick={() => handleAction('overwrite')}
          >
            {t('sftp.conflict.overwrite')}
          </Button>
          {conflict.existingKind === 'directory' && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => handleAction('replace')}
            >
              {t('sftp.conflict.replace')}
            </Button>
          )}
        </SftpDialogFooter>
      </SftpDialogContent>
    </Dialog>
  );
};
