import { createPortal } from 'react-dom';
import { createContext, useContext, useId, type ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { CloseIcon } from './Icons';
import { cn } from '../../lib/ui';

const DialogTitleIdContext = createContext<string | undefined>(undefined);

interface DialogProps {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
}

export function Dialog({ open, onClose, children }: DialogProps) {
  const titleId = useId();

  if (!open) return null;

  return createPortal(
    <DialogTitleIdContext.Provider value={titleId}>
      <div
        className="fixed inset-0 z-[1600] flex items-center justify-center p-4"
        role="presentation"
        style={{ background: 'var(--app-overlay)' }}
        onClick={onClose}
      >
        {children}
      </div>
    </DialogTitleIdContext.Provider>,
    document.body,
  );
}

interface DialogPanelProps {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}

export function DialogPanel({ children, className, ariaLabel }: DialogPanelProps) {
  const titleId = useContext(DialogTitleIdContext);

  return (
    <div
      className={cn('rounded-md', className)}
      role="dialog"
      aria-modal="false"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : titleId}
      style={{
        background: 'var(--app-panel-primary)',
        color: 'var(--app-text)',
      }}
      onClick={(event: React.MouseEvent) => event.stopPropagation()}
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
  const titleId = useContext(DialogTitleIdContext);

  return (
    <div className={cn('flex items-start justify-between gap-2', className)}>
      <div className="flex flex-col gap-1">
        {kicker ? <p className="label">{kicker}</p> : null}
        <h3 id={titleId} className="dialog-title text-sm font-semibold">{title}</h3>
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
