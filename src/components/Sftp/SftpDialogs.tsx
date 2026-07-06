import React, { useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Dialog } from '@/components/ui/Dialog';

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
  const [value, setValue] = useState(defaultValue);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onConfirm(value);
              onClose();
            }}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <label className="text-xs text-app-text-soft">{label}</label>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
      </div>
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
  const [value, setValue] = useState(defaultValue.toString(8));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('common.permissions')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              const parsed = parseInt(value, 8);
              if (!Number.isNaN(parsed)) {
                onConfirm(parsed);
              }
              onClose();
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <label className="text-xs text-app-text-soft">Octal (e.g. 644)</label>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
      </div>
    </Dialog>
  );
};
