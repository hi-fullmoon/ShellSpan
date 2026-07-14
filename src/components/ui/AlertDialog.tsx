import React from 'react';
import { cn } from '@/lib/utils';
import { Button } from './Button';
import { Dialog } from './Dialog';

export interface AlertDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm?: () => void;
  title: string;
  description?: string;
  confirmText: string;
  cancelText?: string;
  variant?: 'danger' | 'primary';
}

const AlertIcon: React.FC<{ variant: AlertDialogProps['variant'] }> = ({
  variant,
}) => {
  const className = cn(
    'h-5 w-5',
    variant === 'danger' ? 'text-app-error' : 'text-app-primary',
  );

  if (variant === 'danger') {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
      >
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
};

export const AlertDialog: React.FC<AlertDialogProps> = ({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmText,
  cancelText,
  variant = 'primary',
}) => {
  const handleConfirm = (): void => {
    onConfirm?.();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <AlertIcon variant={variant} />
          <span>{title}</span>
        </div>
      }
      footer={
        <>
          {cancelText && (
            <Button variant="secondary" onClick={onClose}>
              {cancelText}
            </Button>
          )}
          <Button
            variant={variant === 'danger' ? 'danger' : 'primary'}
            onClick={handleConfirm}
          >
            {confirmText}
          </Button>
        </>
      }
    >
      {description && (
        <p className="text-sm text-app-text">{description}</p>
      )}
    </Dialog>
  );
};
