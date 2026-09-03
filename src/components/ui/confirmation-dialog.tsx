import React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogMedia,
} from '@/components/ui/alert-dialog';
import {
  CompactAlertDialogBody,
  CompactAlertDialogContent,
  CompactAlertDialogDescription,
  CompactAlertDialogFooter,
  CompactAlertDialogHeader,
  CompactAlertDialogTitle,
} from '@/components/ui/compact-alert-dialog';
import { useI18n } from '@/hooks/useI18n';

export interface ConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description: React.ReactNode;
  confirmLabel: React.ReactNode;
  onConfirm: () => void;
  confirmVariant?: React.ComponentProps<typeof AlertDialogAction>['variant'];
  buttonSize?: React.ComponentProps<typeof AlertDialogAction>['size'];
  confirmDisabled?: boolean;
  cancelDisabled?: boolean;
  media?: React.ReactNode;
  children?: React.ReactNode;
}

/** Shared compact layout for actions that require an explicit second confirmation. */
export const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  confirmVariant = 'default',
  buttonSize = 'sm',
  confirmDisabled = false,
  cancelDisabled = false,
  media,
  children,
}) => {
  const { t } = useI18n();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <CompactAlertDialogContent>
        <CompactAlertDialogHeader>
          {media && (
            <AlertDialogMedia className="mb-0">
              {media}
            </AlertDialogMedia>
          )}
          <CompactAlertDialogTitle>{title}</CompactAlertDialogTitle>
        </CompactAlertDialogHeader>
        <CompactAlertDialogBody>
          <CompactAlertDialogDescription className="block min-w-0 max-w-full break-all text-app-text">
            {description}
          </CompactAlertDialogDescription>
          {children}
        </CompactAlertDialogBody>
        <CompactAlertDialogFooter>
          <AlertDialogCancel size={buttonSize} disabled={cancelDisabled}>
            {t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={confirmVariant}
            size={buttonSize}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AlertDialogAction>
        </CompactAlertDialogFooter>
      </CompactAlertDialogContent>
    </AlertDialog>
  );
};
