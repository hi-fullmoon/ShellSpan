import React from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, PromptDialog as BasePromptDialog } from '@/components/ui/dialog';

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
  return (
    <BasePromptDialog
      open={open}
      onClose={onClose}
      onConfirm={onConfirm}
      title={title}
      label={label}
      confirmText={confirmText}
      cancelText={t('common.cancel')}
      defaultValue={defaultValue}
    />
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('common.permissions')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label className="text-xs text-muted-foreground">Octal (e.g. 644)</Label>
          <Input
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
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="default" onClick={handleConfirm}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
