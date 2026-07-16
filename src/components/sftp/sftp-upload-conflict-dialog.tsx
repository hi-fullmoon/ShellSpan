import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useI18n } from '@/hooks/useI18n';
import type { PendingUploadConflict } from '@/hooks/useSftpPaneActions';
import { kindLabel } from '@/lib/sftp-utils';

export type UploadConflictAction = 'overwrite' | 'skip' | 'cancel';

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
    onResolve(action, applyToRemaining);
    setApplyToRemaining(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('sftp.conflict.title')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-app-text">
          {t('sftp.conflict.message', { name: conflict.targetName })}
        </p>
        <div className="rounded-lg bg-app-surface-muted p-3 text-xs text-app-text-soft">
          {kindLabel(conflict.existingKind, t)}
        </div>
        {conflict.remainingConflicts > 0 && (
          <div className="flex items-center gap-2 py-2">
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
        <DialogFooter>
          <Button variant="secondary" onClick={() => handleAction('cancel')}>
            {t('sftp.conflict.cancel')}
          </Button>
          <Button variant="secondary" onClick={() => handleAction('skip')}>
            {t('sftp.conflict.skip')}</Button>
          <Button variant="default" onClick={() => handleAction('overwrite')}>
            {t('sftp.conflict.overwrite')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
