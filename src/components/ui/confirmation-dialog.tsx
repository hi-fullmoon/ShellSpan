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
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/hooks/useI18n';
import { cn } from '@/lib/utils';

type ConfirmationDialogMediaVariant = 'default' | 'warning' | 'destructive';

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
  confirmPending?: boolean;
  cancelDisabled?: boolean;
  media?: React.ReactNode;
  mediaVariant?: ConfirmationDialogMediaVariant;
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
  confirmPending = false,
  cancelDisabled = false,
  media,
  mediaVariant = 'default',
  children,
}) => {
  const { t } = useI18n();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <CompactAlertDialogContent>
        <CompactAlertDialogHeader>
          {media && (
            <AlertDialogMedia
              className={cn(
                'mb-0',
                mediaVariant === 'warning'
                  && 'bg-app-warning/10 text-app-warning ring-1 ring-inset ring-app-warning/20',
                mediaVariant === 'destructive'
                  && 'bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/20',
              )}
            >
              {media}
            </AlertDialogMedia>
          )}
          <CompactAlertDialogTitle className={cn(media && 'self-center')}>
            {title}
          </CompactAlertDialogTitle>
        </CompactAlertDialogHeader>
        <CompactAlertDialogBody>
          <CompactAlertDialogDescription className="block min-w-0 max-w-full break-all text-app-text">
            {description}
          </CompactAlertDialogDescription>
          {children}
        </CompactAlertDialogBody>
        <CompactAlertDialogFooter>
          <AlertDialogCancel size={buttonSize} disabled={cancelDisabled || confirmPending}>
            {t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={confirmVariant}
            size={buttonSize}
            disabled={confirmDisabled || confirmPending}
            aria-busy={confirmPending}
            onClick={onConfirm}
          >
            {confirmPending && <Spinner data-icon="inline-start" aria-hidden="true" />}
            {confirmLabel}
          </AlertDialogAction>
        </CompactAlertDialogFooter>
      </CompactAlertDialogContent>
    </AlertDialog>
  );
};
