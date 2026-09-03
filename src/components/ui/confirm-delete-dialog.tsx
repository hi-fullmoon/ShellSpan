import React from 'react';
import { useI18n } from '@/hooks/useI18n';
import { AlertDialogAction } from '@/components/ui/alert-dialog';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';

interface ConfirmDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  confirmLabel?: string;
  confirmVariant?: React.ComponentProps<typeof AlertDialogAction>['variant'];
  buttonSize?: React.ComponentProps<typeof AlertDialogAction>['size'];
}

/** Destructive-action preset for the shared confirmation dialog. */
export const ConfirmDeleteDialog: React.FC<ConfirmDeleteDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  confirmLabel,
  confirmVariant = 'destructive',
  buttonSize,
}) => {
  const { t } = useI18n();
  return (
    <ConfirmationDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      confirmLabel={confirmLabel ?? t('common.delete')}
      confirmVariant={confirmVariant}
      buttonSize={buttonSize}
      onConfirm={onConfirm}
    />
  );
};
