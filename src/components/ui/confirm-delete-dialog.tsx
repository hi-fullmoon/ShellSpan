import React from 'react';
import { useI18n } from '@/hooks/useI18n';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

interface ConfirmDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  confirmLabel?: string;
}

/** Shared destructive-action confirmation dialog (compact file-manager style). */
export const ConfirmDeleteDialog: React.FC<ConfirmDeleteDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  confirmLabel,
}) => {
  const { t } = useI18n();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="min-w-0 max-w-sm gap-0 overflow-hidden border-app-border bg-app-surface p-0">
        <AlertDialogHeader className="place-items-start px-4 py-2.5 text-left">
          <AlertDialogTitle className="text-sm leading-5">{title}</AlertDialogTitle>
        </AlertDialogHeader>
        <div className="min-w-0 max-w-full overflow-hidden px-4 py-3">
          <AlertDialogDescription className="block min-w-0 max-w-full break-all text-left leading-5 text-app-text">
            {description}
          </AlertDialogDescription>
        </div>
        <AlertDialogFooter className="mx-0 mb-0 rounded-none border-t-0 bg-app-surface px-4 py-2.5">
          <AlertDialogCancel size="sm">{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" size="sm" onClick={onConfirm}>
            {confirmLabel ?? t('common.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
