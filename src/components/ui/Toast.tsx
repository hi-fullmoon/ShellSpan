import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { useToastStore, type ToastItem, type ToastVariant } from '@/stores/toastStore';

const TOAST_ANIMATION_DURATION = 200;
const TOAST_STACK_THRESHOLD = 3;

interface ToastIconProps {
  variant: ToastVariant;
}

const ToastIcon: React.FC<ToastIconProps> = ({ variant }) => {
  const className = 'h-4 w-4 shrink-0';

  switch (variant) {
    case 'success':
      return (
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn(className, 'text-app-success')}
        >
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      );
    case 'error':
      return (
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn(className, 'text-app-error')}
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
      );
    case 'info':
    default:
      return (
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn(className, 'text-app-primary')}
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      );
  }
};

interface ToastProps {
  toast: ToastItem;
  onRemove: (id: string) => void;
  groupPaused?: boolean;
}

const Toast: React.FC<ToastProps> = ({
  toast,
  onRemove,
  groupPaused = false,
}) => {
  const [exiting, setExiting] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remainingDurationRef = useRef(toast.duration);
  const countdownStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (groupPaused || hovered || focused || exiting) return;

    countdownStartedAtRef.current = Date.now();
    const timer = window.setTimeout(() => {
      countdownStartedAtRef.current = null;
      remainingDurationRef.current = 0;
      setExiting(true);
    }, remainingDurationRef.current);

    return () => {
      window.clearTimeout(timer);
      if (countdownStartedAtRef.current !== null) {
        const elapsed = Date.now() - countdownStartedAtRef.current;
        remainingDurationRef.current = Math.max(
          0,
          remainingDurationRef.current - elapsed,
        );
        countdownStartedAtRef.current = null;
      }
    };
  }, [exiting, focused, groupPaused, hovered]);

  useEffect(() => {
    if (!exiting) return;

    const timer = window.setTimeout(() => {
      onRemove(toast.id);
    }, TOAST_ANIMATION_DURATION);

    return () => window.clearTimeout(timer);
  }, [exiting, onRemove, toast.id]);

  const handleDismiss = (): void => {
    setExiting(true);
  };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
        }
      }}
      className={cn(
        'pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-app-border bg-app-surface p-3.5 shadow-[var(--shadow-toast)] backdrop-blur-sm transition-all motion-reduce:transition-none',
        exiting ? 'translate-x-4 opacity-0' : 'translate-x-0 opacity-100',
      )}
      role={toast.variant === 'error' ? 'alert' : 'status'}
      aria-live={toast.variant === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <ToastIcon variant={toast.variant} />
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-app-text">
        {toast.message}
      </span>
      <button
        type="button"
        onClick={handleDismiss}
        className="shrink-0 rounded-md p-0.5 text-app-text-soft transition-colors hover:bg-app-surface-muted hover:text-app-text focus:outline-none focus-visible:ring-2 focus-visible:ring-app-primary/50"
        aria-label="Close"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
};

export const Toaster: React.FC = () => {
  const toasts = useToastStore((state) => state.toasts);
  const removeToast = useToastStore((state) => state.removeToast);
  const [groupHovered, setGroupHovered] = useState(false);
  const [groupFocused, setGroupFocused] = useState(false);

  useEffect(() => {
    if (toasts.length === 0) {
      setGroupHovered(false);
      setGroupFocused(false);
    }
  }, [toasts.length]);

  if (toasts.length === 0) return null;

  const stacked = toasts.length > TOAST_STACK_THRESHOLD;
  const groupPaused = groupHovered || groupFocused;
  const expanded = !stacked || groupPaused;
  const latestIndex = toasts.length - 1;

  return createPortal(
    <div
      data-testid="toast-stack"
      data-collapsed={stacked && !expanded}
      onMouseEnter={() => setGroupHovered(true)}
      onMouseLeave={() => setGroupHovered(false)}
      onFocusCapture={() => setGroupFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setGroupFocused(false);
        }
      }}
      className={cn(
        'fixed bottom-4 right-4 z-[2000] w-[min(20rem,calc(100vw-2rem))]',
        expanded && 'flex flex-col gap-2',
      )}
    >
      {toasts.map((toast, index) => {
        const depth = latestIndex - index;
        const hidden = !expanded && depth > 2;

        return (
          <div
            key={toast.id}
            data-toast-depth={depth}
            data-toast-hidden={hidden}
            aria-hidden={!expanded && depth > 0 ? true : undefined}
            inert={!expanded && depth > 0 ? true : undefined}
            className={cn(
              'origin-bottom transition-all duration-200 motion-reduce:transition-none',
              !expanded && depth === 0 && 'relative z-30',
              !expanded &&
                depth === 1 &&
                'pointer-events-none absolute inset-x-0 bottom-0 z-20 -translate-y-2 scale-x-[0.96] opacity-80',
              !expanded &&
                depth === 2 &&
                'pointer-events-none absolute inset-x-0 bottom-0 z-10 -translate-y-4 scale-x-[0.92] opacity-60',
              hidden && 'invisible absolute inset-x-0 bottom-0',
            )}
          >
            <Toast
              toast={toast}
              onRemove={removeToast}
              groupPaused={groupPaused}
            />
          </div>
        );
      })}
    </div>,
    document.body,
  );
};
