import React from 'react';
import { useI18n } from '@/hooks/useI18n';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog';
import {
  CompactAlertDialogBody,
  CompactAlertDialogContent,
  CompactAlertDialogFooter,
  CompactAlertDialogHeader,
  CompactAlertDialogTitle,
} from '@/components/ui/compact-alert-dialog';

interface ConfirmDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  confirmLabel?: string;
  confirmVariant?: React.ComponentProps<typeof AlertDialogAction>['variant'];
}

/** Shared destructive-action confirmation dialog (compact file-manager style). */
export const ConfirmDeleteDialog: React.FC<ConfirmDeleteDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  confirmLabel,
  confirmVariant = 'destructive',
}) => {
  const { t } = useI18n();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <CompactAlertDialogContent>
        <CompactAlertDialogHeader>
          <CompactAlertDialogTitle>{title}</CompactAlertDialogTitle>
        </CompactAlertDialogHeader>
        <CompactAlertDialogBody>
          <AlertDialogDescription className="block min-w-0 max-w-full break-all text-left leading-5 text-app-text">
            {description}
          </AlertDialogDescription>
        </CompactAlertDialogBody>
        <CompactAlertDialogFooter>
          <AlertDialogCancel size="sm">{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant={confirmVariant} size="sm" onClick={onConfirm}>
            {confirmLabel ?? t('common.delete')}
          </AlertDialogAction>
        </CompactAlertDialogFooter>
      </CompactAlertDialogContent>
    </AlertDialog>
  );
};
