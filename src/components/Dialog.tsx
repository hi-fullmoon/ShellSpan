import type { ReactNode } from 'react';
import { t } from '../lib/i18n';
import { CloseIcon } from './Icons';
import { cn } from '../lib/ui';

interface DialogProps {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
}

export function Dialog({ open, onClose, children }: DialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="app-overlay" role="presentation" onClick={onClose}>
      {children}
    </div>
  );
}

interface DialogPanelProps {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}

export function DialogPanel({ children, className, ariaLabel }: DialogPanelProps) {
  return (
    <div
      className={cn('app-dialog surface w-full max-w-sm p-3', className)}
      onClick={(event) => event.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
}

interface DialogHeaderProps {
  kicker?: string;
  title: string;
  description?: string;
  onClose?: () => void;
  closeLabel?: string;
  className?: string;
}

export function DialogHeader({ kicker, title, description, onClose, closeLabel, className }: DialogHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-2', className)}>
      <div className="flex flex-col gap-1">
        {kicker ? <p className="label">{kicker}</p> : null}
        <h3 className="dialog-title text-sm font-semibold">{title}</h3>
        {description ? <p className="dialog-description text-xs">{description}</p> : null}
      </div>
      {onClose ? (
        <button
          aria-label={closeLabel ?? t('app.common.close')}
          className="icon-btn shrink-0"
          onClick={onClose}
          type="button"
        >
          <CloseIcon />
        </button>
      ) : null}
    </div>
  );
}

interface DialogFooterProps {
  children: ReactNode;
  className?: string;
}

export function DialogFooter({ children, className }: DialogFooterProps) {
  return <div className={cn('mt-3 flex justify-end gap-1', className)}>{children}</div>;
}
