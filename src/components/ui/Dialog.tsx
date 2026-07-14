import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Button } from './Button';
import { Input } from './Input';

const DIALOG_ANIMATION_DURATION = 150;

interface UseAnimatedOpenResult {
  mounted: boolean;
  closing: boolean;
}

function useAnimatedOpen(open: boolean): UseAnimatedOpenResult {
  const [state, setState] = useState<{ mounted: boolean; closing: boolean }>({
    mounted: open,
    closing: false,
  });
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setState({ mounted: true, closing: false });
    } else if (state.mounted) {
      setState((prev) => ({ ...prev, closing: true }));
      timeoutRef.current = window.setTimeout(() => {
        setState({ mounted: false, closing: false });
      }, DIALOG_ANIMATION_DURATION);
    }

    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, [open, state.mounted]);

  return state;
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export const Dialog: React.FC<DialogProps> = ({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}) => {
  const { mounted, closing } = useAnimatedOpen(open);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mounted) return;

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [mounted, onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className={cn(
          'absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity',
          closing ? 'opacity-0' : 'opacity-100',
        )}
        onClick={onClose}
        role="presentation"
      />
      <div
        ref={panelRef}
        className={cn(
          'relative z-10 flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-[var(--shadow-dialog)] transition-all',
          closing ? 'scale-95 opacity-0' : 'scale-100 opacity-100',
          className,
        )}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div className="flex flex-col gap-1">
            <span className="text-base font-semibold text-app-text">{title}</span>
            {description && (
              <span className="text-xs text-app-text-soft">{description}</span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="close"
            className="-mr-1 -mt-1 shrink-0"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </Button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 px-5 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmText,
  cancelText,
}) => {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {cancelText}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmText}
          </Button>
        </>
      }
    >
      <p className="text-sm text-app-text">{message}</p>
    </Dialog>
  );
};

export interface PromptDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (value: string) => void;
  title: string;
  label: string;
  confirmText: string;
  cancelText: string;
  defaultValue?: string;
}

export const PromptDialog: React.FC<PromptDialogProps> = ({
  open,
  onClose,
  onConfirm,
  title,
  label,
  confirmText,
  cancelText,
  defaultValue = '',
}) => {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    if (open) {
      setValue(defaultValue ?? '');
    }
  }, [open, defaultValue]);

  const handleConfirm = (): void => {
    onConfirm(value);
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      handleConfirm();
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {cancelText}
          </Button>
          <Button variant="primary" onClick={handleConfirm}>
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
          onKeyDown={handleKeyDown}
          autoFocus
        />
      </div>
    </Dialog>
  );
};
