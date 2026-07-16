import React from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import {
  SftpDialogBody,
  SftpDialogContent,
  SftpDialogFooter,
  SftpDialogHeader,
} from './sftp-dialog-layout';

export interface PromptDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (value: string) => void;
  title: string;
  label: string;
  confirmText: string;
  defaultValue?: string;
}

export const PromptDialog: React.FC<PromptDialogProps> = ({
  open,
  onClose,
  onConfirm,
  title,
  label,
  confirmText,
  defaultValue = '',
}) => {
  const { t } = useI18n();
  const [value, setValue] = React.useState(defaultValue);

  React.useEffect(() => {
    if (open) {
      setValue(defaultValue);
    }
  }, [open, defaultValue]);

  const handleConfirm = (): void => {
    if (!value.trim()) return;
    onConfirm(value);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SftpDialogContent className="max-w-sm" showCloseButton={false}>
        <SftpDialogHeader title={title} />
        <SftpDialogBody>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sftp-prompt-input" className="text-xs text-muted-foreground">
              {label}
            </Label>
            <Input
              id="sftp-prompt-input"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleConfirm();
              }}
              autoFocus
            />
          </div>
        </SftpDialogBody>
        <SftpDialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleConfirm} disabled={!value.trim()}>
            {confirmText}
          </Button>
        </SftpDialogFooter>
      </SftpDialogContent>
    </Dialog>
  );
};

export interface PermissionsDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (permissions: number) => void;
  defaultValue?: number;
}

export const PermissionsDialog: React.FC<PermissionsDialogProps> = ({
  open,
  onClose,
  onConfirm,
  defaultValue = 0o644,
}) => {
  const { t } = useI18n();
  const [value, setValue] = React.useState(defaultValue.toString(8));

  React.useEffect(() => {
    if (open) {
      setValue(defaultValue.toString(8));
    }
  }, [open, defaultValue]);

  const handleConfirm = (): void => {
    const parsed = parseInt(value, 8);
    if (!Number.isNaN(parsed)) {
      onConfirm(parsed);
    }
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
      <SftpDialogContent className="max-w-xs" showCloseButton={false}>
        <SftpDialogHeader title={t('common.permissions')} />
        <SftpDialogBody>
          <div className="flex flex-col gap-2">
            <Label htmlFor="sftp-permissions-input" className="text-xs text-muted-foreground">
              Octal (e.g. 644)
            </Label>
            <Input
              id="sftp-permissions-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleConfirm();
                }
              }}
              autoFocus
            />
          </div>
        </SftpDialogBody>
        <SftpDialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleConfirm}>
            {t('common.save')}
          </Button>
        </SftpDialogFooter>
      </SftpDialogContent>
    </Dialog>
  );
};
